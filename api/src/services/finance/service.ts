import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../errors/app-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { parseCoordinates } from "../climate/coordinates.js";
import type { ClimateService } from "../climate/profile.service.js";
import type { ClimateProfile } from "../climate/schema.js";
import { HAZARDS, type Hazard, type LatLon } from "../climate/types.js";
import { fallbackConditions } from "../input/classifier/defaults.js";
import {
  INSURANCE_COVERS,
  PROPOSED_LOAN_STATUSES,
  SECTORS,
  financialsSchema,
  loanSchema,
  type Sector,
} from "../input/schemas/index.js";
import type { BusinessDetail, InputService } from "../input/service.js";
import { currentYear } from "../input/validation.js";
import { FINANCE } from "./config.js";
import { DEMO } from "./demo.js";
import { noFinancials, parseInput } from "./errors.js";
import {
  amortisedEmi,
  computeMetrics,
  debtCover,
  round,
  type FinanceInputs,
  type FinanceMetrics,
} from "./metrics/compute.js";
import {
  assessmentSummary,
  buildProfile,
  climateRef,
  toIstIso,
  type Assessment,
  type ClimateRef,
} from "./profile/build.js";
import type { FinanceProfile } from "./profile/schema.js";
import { adjustScore, driverReason, hazardLabel, type AdjustedScore } from "./scoring/adjusted.js";
import type { ScoreResult } from "./scoring/baseline.js";
import { rulesScorer, type Scorer } from "./scoring/scorer.js";
import {
  toSensitivities,
  type HazardSensitivities,
  type HazardSensitivity,
  type SensitivitySource,
} from "./scoring/sensitivity.js";
import {
  stressHazard,
  stressTest,
  type HazardStress,
  type InsuranceCover,
  type StressContext,
  type StressResults,
} from "./scoring/stress.js";
import * as store from "./store.js";

// The finance pipeline (README section 2):
//
//   load business → compute metrics → baseline score
//                 → climate profile (the climate unit's entry function, read only)
//                 → stress test per hazard → adjusted score and drivers
//                 → build profile → output validation → store → log request
//
// Businesses are read through the input service and never written.

export interface FinanceServiceDeps {
  prisma: PrismaClient;
  // The input service: where businesses, snapshots, loans and
  // weather-impact profiles live
  businesses: Pick<InputService, "getBusiness">;
  climate: Pick<ClimateService, "getProfile">;
  // Defaults to the rules
  scorer?: Scorer;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
}

export interface ProfileOptions {
  // What asked for the profile; stored with it
  trigger?: store.ProfileTrigger;
  requesterId?: string | null;
}

export interface ScenarioResult {
  business_id: string;
  generated_at: string;
  scenario: { hazard: Hazard; severity: number; duration_months: number };
  baseline: ScoreResult;
  sensitivity: HazardSensitivity;
  stress: HazardStress;
  adjusted: AdjustedScore;
  summary: string;
  warnings: string[];
}

export interface LocationEvaluation {
  location: LatLon;
  generated_at: string;
  model_version: string;
  // The requested loan as it was counted, with its EMI
  loan_request: { amount: number; tenure_months: number; interest_rate: number; emi: number } | null;
  baseline: ScoreResult;
  metrics: FinanceMetrics;
  climate: ClimateRef | null;
  sensitivity: { source: SensitivitySource; hazards: HazardSensitivities };
  stress: StressResults | Record<string, never>;
  adjusted: AdjustedScore | null;
  summary: string;
  warnings: string[];
}

export interface RepaymentCapacity {
  business_id: string;
  generated_at: string;
  scenario: { revenue_drop_pct: number; months: number };
  stressed: { monthly_revenue: number; net_monthly_cashflow: number; dscr: number | null };
  current_total_emi: number;
  target_dscr: number;
  // The largest EMI the stressed cashflow covers at `target_dscr`
  max_affordable_emi: number;
  // Cash the business must find each month to meet costs and repayments
  shortfall_per_month: number;
  total_shortfall: number;
  cash_reserves: number;
  // null when there is no shortfall to cover
  reserves_cover_months: number | null;
  uncovered_after_reserves: number;
  summary: string;
  warnings: string[];
}

export interface FinanceService {
  // The entry function
  getFinanceProfile(businessId: string, options?: ProfileOptions): Promise<FinanceProfile>;
  // Stored profiles of a business, newest first
  listProfiles(businessId: string, limit?: number): Promise<store.ProfileSummary[]>;
  // The stress test for a hypothetical event
  simulateScenario(businessId: string, scenario: unknown): Promise<ScenarioResult>;
  // Scores a business that is not stored, at a candidate location
  evaluateLocation(
    draft: unknown,
    lat: unknown,
    lon: unknown,
    options?: Pick<ProfileOptions, "requesterId">,
  ): Promise<LocationEvaluation>;
  repaymentCapacity(businessId: string, scenario: unknown): Promise<RepaymentCapacity>;
  // The built-in sample business, end to end
  demo(options?: Pick<ProfileOptions, "requesterId">): Promise<{
    sample: typeof DEMO;
    result: LocationEvaluation;
  }>;
}

const scenarioSchema = z.strictObject({
  hazard: z.enum(HAZARDS),
  severity: z.number().min(0).max(1),
  duration_months: z.number().int().min(1).max(24).default(FINANCE.stress.durationMonths),
});

const capacitySchema = z.strictObject({
  revenue_drop_pct: z.number().min(0).max(100),
  months: z.number().int().min(1).max(60),
});

const draftSchema = z.strictObject({
  sector: z.enum(SECTORS),
  years_in_operation: z.number().int().min(0).max(150),
  insurance_covers: z.array(z.enum(INSURANCE_COVERS)).max(INSURANCE_COVERS.length).default([]),
  financials: financialsSchema
    .omit({ as_of: true, receivables_days: true })
    .refine((financials) => financials.monthly_revenue.some((month) => month > 0), {
      path: ["monthly_revenue"],
      message: "Needs at least one month above zero",
    }),
  // Without an `emi`, it is worked out by amortisation
  loan_request: loanSchema.omit({ purpose: true }).partial({ emi: true }).optional(),
});

// Everything the pipeline needs to know about one business
interface Subject {
  inputs: FinanceInputs;
  sector: Sector;
  insuranceCovers: InsuranceCover[];
  point: LatLon;
  sensitivity: { source: SensitivitySource; hazards: HazardSensitivities };
  warnings: string[];
}

interface Trace {
  requestId: string;
  stageMs: Record<string, number>;
  fallbacks: string[];
  sensitivitySource: string | null;
  scorerSource: string | null;
}

const SOURCE_BY_STATUS = { ok: "llm", fallback: "fallback", overridden: "override" } as const;

function sensitivityOf(business: BusinessDetail, warnings: string[]): Subject["sensitivity"] {
  const profile = business.impact_profile;
  if (profile?.conditions && profile.status !== "pending") {
    return { source: SOURCE_BY_STATUS[profile.status], hazards: toSensitivities(profile.conditions) };
  }
  warnings.push("impact_profile_pending: the classifier has not finished; sector defaults used");
  return {
    source: "fallback",
    hazards: toSensitivities(
      fallbackConditions(business.profile.sector, "the classifier has not finished"),
    ),
  };
}

function contextOf(subject: Subject, durationMonths?: number): StressContext {
  return { sector: subject.sector, insuranceCovers: subject.insuranceCovers, durationMonths };
}

export function createFinanceService(deps: FinanceServiceDeps): FinanceService {
  const { prisma } = deps;
  const scorer = deps.scorer ?? rulesScorer;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  // Runs one operation and writes its row of finance_request_log
  async function traced<T>(
    operation: store.RequestLogEntry["operation"],
    businessId: string | null,
    work: (trace: Trace) => Promise<T>,
  ): Promise<T> {
    const trace: Trace = {
      requestId: randomUUID(),
      stageMs: {},
      fallbacks: [],
      sensitivitySource: null,
      scorerSource: null,
    };
    const startedAt = performance.now();
    const record = async (errorCode: string | null) => {
      try {
        await store.logRequest(prisma, {
          ...trace,
          operation,
          businessId: businessId?.slice(0, 64) ?? null,
          ok: errorCode === null,
          errorCode,
          latencyMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        logger.warn("finance: saving the request log failed", error);
      }
    };
    try {
      const result = await work(trace);
      await record(null);
      return result;
    } catch (error) {
      await record(error instanceof AppError ? error.code : "INTERNAL_ERROR");
      throw error;
    }
  }

  async function stage<T>(trace: Trace, name: string, work: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      trace.stageMs[name] = Math.round(performance.now() - startedAt);
    }
  }

  async function loadSubject(businessId: string, trace: Trace) {
    const business = await stage(trace, "load_business", () => deps.businesses.getBusiness(businessId));
    const snapshot = business.latest_snapshot;
    if (!snapshot) throw noFinancials(businessId);

    const warnings: string[] = [];
    if (!snapshot.verified_by_bank) {
      warnings.push("snapshot_unverified: the financials have not been verified by the bank");
    }
    // Loans asked for or granted but not yet being repaid. One that is
    // being repaid is already inside the owner's `existing_emi_total`.
    const proposed = business.loans.filter((loan) => PROPOSED_LOAN_STATUSES.includes(loan.status));
    const { operations } = business;
    const subject: Subject = {
      inputs: {
        monthly_revenue: snapshot.raw.monthly_revenue,
        monthly_expenses: snapshot.raw.monthly_opex,
        existing_emi: snapshot.raw.existing_emi_total,
        proposed_emi: proposed.reduce((sum, loan) => sum + loan.emi, 0),
        outstanding_debt: snapshot.raw.outstanding_debt,
        proposed_principal: proposed.reduce((sum, loan) => sum + loan.amount, 0),
        cash_reserves: snapshot.raw.cash_balance,
        missed_payments_12m: snapshot.raw.payment_delays_12m,
        years_in_operation: Math.max(0, currentYear(now()) - business.profile.year_started),
      },
      sector: business.profile.sector,
      insuranceCovers: operations.has_insurance ? (operations.insurance_covers ?? []) : [],
      point: { lat: business.locations.primary.lat, lon: business.locations.primary.lon },
      sensitivity: sensitivityOf(business, warnings),
      warnings,
    };
    trace.sensitivitySource = subject.sensitivity.source;
    if (subject.sensitivity.source === "fallback") trace.fallbacks.push("sensitivity_sector_defaults");

    const refs: FinanceProfile["inputs"] = {
      snapshot_version: snapshot.version,
      snapshot_as_of: snapshot.as_of,
      snapshot_verified: snapshot.verified_by_bank,
      proposed_loan_ids: proposed.map((loan) => loan.id),
      impact_profile_version: business.impact_profile?.version ?? null,
    };
    return { subject, refs };
  }

  async function measure(subject: Subject, trace: Trace, warnings: string[]) {
    const metrics = await stage(trace, "metrics", () => computeMetrics(subject.inputs));
    if (metrics.months_of_history < 12) {
      warnings.push(
        `short_revenue_history: ${String(metrics.months_of_history)} months; seasonality may be understated`,
      );
    }
    if (metrics.net_monthly_cashflow < 0) {
      warnings.push("operating_loss: average expenses are above average revenue");
    }
    const outcome = await stage(trace, "baseline", () => scorer.score(metrics));
    trace.scorerSource = outcome.result.source;
    if (outcome.fallback) {
      trace.fallbacks.push("scorer_rules");
      warnings.push(outcome.fallback);
    }
    return { metrics, baseline: outcome.result };
  }

  // Metrics, baseline, and as much of the climate side as can be had. A
  // failing climate unit costs the stress test, never the baseline.
  async function assess(
    subject: Subject,
    trace: Trace,
    requesterId: string | null,
  ): Promise<Assessment> {
    const warnings = [...subject.warnings];
    const { metrics, baseline } = await measure(subject, trace, warnings);
    const { sensitivity } = subject;

    let climate: ClimateProfile | null = null;
    try {
      climate = await stage(trace, "climate", () => deps.climate.getProfile(subject.point, requesterId));
    } catch (error) {
      const reason =
        error instanceof AppError ? error.code : error instanceof Error ? error.message : "unknown error";
      logger.warn(`finance: the climate profile is unavailable (${reason}); returning the baseline only`);
      trace.fallbacks.push("climate_unavailable");
      warnings.push(`climate_unavailable: ${reason}; baseline only, no stress test or adjusted score`);
    }
    if (!climate) {
      return { metrics, baseline, climate: null, sensitivity, stress: {}, adjusted: null, warnings };
    }

    const fetchedAt = now();
    const scores = climate.hazards;
    const severities = Object.fromEntries(scores.map((entry) => [entry.hazard, entry.score])) as Record<
      Hazard,
      number
    >;
    const stress = await stage(trace, "stress", () =>
      stressTest(metrics, severities, sensitivity.hazards, contextOf(subject)),
    );
    const adjusted = await stage(trace, "adjusted", () => adjustScore(baseline, metrics, stress));
    return {
      metrics,
      baseline,
      climate: climateRef(climate, fetchedAt),
      sensitivity,
      stress,
      adjusted,
      warnings,
    };
  }

  const service: FinanceService = {
    getFinanceProfile(businessId, options = {}) {
      return traced("profile", businessId, async (trace) => {
        const { subject, refs } = await loadSubject(businessId, trace);
        const assessment = await assess(subject, trace, options.requesterId ?? null);
        const profile = await stage(trace, "build", () =>
          buildProfile({
            ...assessment,
            businessId,
            generatedAt: now(),
            modelVersion: FINANCE.modelVersion,
            inputs: refs,
          }),
        );
        await stage(trace, "store", async () => {
          try {
            await store.insertProfile(prisma, {
              trigger: options.trigger ?? "request",
              inputs: subject.inputs,
              profile,
            });
          } catch (error) {
            logger.error("finance: saving the profile failed", error);
            profile.warnings.push("persistence_failed: this profile was not added to the history");
          }
        });
        return profile;
      });
    },

    listProfiles(businessId, limit = 20) {
      return store.listProfiles(prisma, businessId, limit);
    },

    simulateScenario(businessId, scenario) {
      return traced("scenario", businessId, async (trace) => {
        const input = parseInput(scenarioSchema, scenario);
        const { subject } = await loadSubject(businessId, trace);
        const warnings = [...subject.warnings];
        const { metrics, baseline } = await measure(subject, trace, warnings);

        const sensitivity = subject.sensitivity.hazards[input.hazard];
        const stress = await stage(trace, "stress", () =>
          stressHazard(
            metrics,
            input.hazard,
            input.severity,
            sensitivity,
            contextOf(subject, input.duration_months),
          ),
        );
        const adjusted = adjustScore(baseline, metrics, { [input.hazard]: stress });
        const effect =
          stress.shock_pct === 0
            ? `${hazardLabel(input.hazard)} at severity ${String(input.severity)} has no material effect on this business's revenue`
            : driverReason(input.hazard, metrics, stress);
        const breach = stress.breach
          ? ` Breaches: ${stress.breach_reasons.join(", ")}.`
          : " No threshold is breached.";

        return {
          business_id: businessId,
          generated_at: toIstIso(now()),
          scenario: input,
          baseline,
          sensitivity,
          stress,
          adjusted,
          summary:
            `${effect}, over ${String(input.duration_months)} months. ` +
            `Score ${String(baseline.score)} (${baseline.band}) becomes ${String(adjusted.score)} (${adjusted.band}).${breach}`,
          warnings,
        };
      });
    },

    evaluateLocation(draft, lat, lon, options = {}) {
      return traced("evaluate_location", null, async (trace) => {
        const input = parseInput(draftSchema, draft);
        const point = parseCoordinates(lat, lon);
        const { financials, loan_request: loan } = input;
        const rate = loan?.interest_rate ?? FINANCE.metrics.defaultInterestRatePct;
        const loanRequest = loan
          ? {
              amount: loan.amount,
              tenure_months: loan.tenure_months,
              interest_rate: rate,
              emi: loan.emi ?? amortisedEmi(loan.amount, rate, loan.tenure_months),
            }
          : null;

        const subject: Subject = {
          inputs: {
            monthly_revenue: financials.monthly_revenue,
            monthly_expenses: financials.monthly_opex,
            existing_emi: financials.existing_emi_total,
            proposed_emi: loanRequest?.emi ?? 0,
            outstanding_debt: financials.outstanding_debt,
            proposed_principal: loanRequest?.amount ?? 0,
            cash_reserves: financials.cash_balance,
            missed_payments_12m: financials.payment_delays_12m,
            years_in_operation: input.years_in_operation,
          },
          sector: input.sector,
          insuranceCovers: input.insurance_covers,
          point,
          // Nothing has read a description of this business
          sensitivity: {
            source: "fallback",
            hazards: toSensitivities(fallbackConditions(input.sector, "an unsaved business is not classified")),
          },
          warnings: ["sensitivity_sector_defaults: an unsaved business is scored on its sector's defaults"],
        };
        trace.sensitivitySource = "fallback";
        trace.fallbacks.push("sensitivity_sector_defaults");

        const assessment = await assess(subject, trace, options.requesterId ?? null);
        return {
          location: point,
          generated_at: toIstIso(now()),
          model_version: FINANCE.modelVersion,
          loan_request: loanRequest,
          ...assessment,
          summary: assessmentSummary(assessment),
        };
      });
    },

    repaymentCapacity(businessId, scenario) {
      return traced("repayment_capacity", businessId, async (trace) => {
        const input = parseInput(capacitySchema, scenario);
        const { subject } = await loadSubject(businessId, trace);
        const metrics = await stage(trace, "metrics", () => computeMetrics(subject.inputs));

        const revenue = metrics.avg_monthly_revenue * (1 - input.revenue_drop_pct / 100);
        const cover = debtCover({
          revenue,
          expenses: metrics.avg_monthly_expenses,
          totalEmi: metrics.total_emi,
          cash: metrics.cash_reserves,
        });
        const { targetDscr } = FINANCE.capacity;
        const maxEmi = Math.max(0, Math.floor(cover.net_monthly_cashflow / targetDscr));
        const shortfall = Math.max(0, round(-cover.surplus_after_debt, 2));
        const total = round(shortfall * input.months, 2);
        const uncovered = Math.max(0, round(total - metrics.cash_reserves, 2));
        const coverMonths = shortfall > 0 ? round(metrics.cash_reserves / shortfall, 1) : null;

        const inr = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
        const outcome =
          shortfall === 0
            ? `the business still meets its EMIs of ${inr(metrics.total_emi)}`
            : `it falls ${inr(shortfall)} short each month (${inr(total)} in all); reserves cover ` +
              `${String(coverMonths)} months, leaving ${inr(uncovered)} uncovered`;

        return {
          business_id: businessId,
          generated_at: toIstIso(now()),
          scenario: input,
          stressed: {
            monthly_revenue: round(revenue, 2),
            net_monthly_cashflow: cover.net_monthly_cashflow,
            dscr: cover.dscr,
          },
          current_total_emi: metrics.total_emi,
          target_dscr: targetDscr,
          max_affordable_emi: maxEmi,
          shortfall_per_month: shortfall,
          total_shortfall: total,
          cash_reserves: metrics.cash_reserves,
          reserves_cover_months: coverMonths,
          uncovered_after_reserves: uncovered,
          summary:
            `With revenue down ${String(input.revenue_drop_pct)}% for ${String(input.months)} months, ${outcome}. ` +
            `The largest EMI it can carry at a DSCR of ${String(targetDscr)} is ${inr(maxEmi)}.`,
          warnings: subject.warnings,
        };
      });
    },

    async demo(options = {}) {
      return {
        sample: DEMO,
        result: await service.evaluateLocation(DEMO.business, DEMO.lat, DEMO.lon, options),
      };
    },
  };
  return service;
}
