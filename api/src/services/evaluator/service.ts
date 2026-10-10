import { AppError, NotFoundError } from "../../errors/app-error.js";
import type { ClimateService } from "../climate/profile.service.js";
import type { LatLon } from "../climate/types.js";
import { FINANCE } from "../finance/config.js";
import { toIstIso } from "../finance/profile/build.js";
import type { FinanceProfile } from "../finance/profile/schema.js";
import type { FinanceService } from "../finance/service.js";
import type { InputService } from "../input/service.js";
import { climateRunRef, runChecks, type ClimateResult, type FinanceResult } from "./checks.js";
import { EVALUATOR } from "./config.js";
import { breachedHazards, combinedRating, reasons } from "./rating.js";
import { evaluationSchema, type Evaluation, type FinanceSummary } from "./schema.js";
import type { EvaluationStore, EvaluationSummary } from "./store.js";

// The evaluator: asks the climate unit and the finance service about one
// business, checks both answers against each other and against their own
// rules, and gives one combined rating with its reasons.
//
//   business → location and latest snapshot (input service)
//            → climate profile (climate unit's entry function)
//            → finance profile (the stored one while it is current, or a new one)
//            → checks → rating and reasons → output validation → store

export interface EvaluatorDeps {
  climate: Pick<ClimateService, "getProfile">;
  // Without these two only the climate side is evaluated (the advisor's
  // demo businesses, and tests)
  businesses?: Pick<InputService, "getBusiness">;
  finance?: Pick<FinanceService, "getFinanceProfile" | "latestProfile">;
  // Without one, evaluations are not stored and carry a null id
  store?: EvaluationStore;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
}

export interface EvaluateRequest {
  businessId: string;
  // Where to look when the input service does not know the business
  point?: LatLon;
  requesterId?: string | null;
}

export interface EvaluatorService {
  evaluate(request: EvaluateRequest): Promise<Evaluation>;
  // Stored evaluations, newest first
  history(businessId: string, limit?: number): Promise<EvaluationSummary[]>;
}

const HOUR_MS = 3_600_000;
const message = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
const notFound = (error: unknown) => error instanceof AppError && error.statusCode === 404;

export function createEvaluatorService(deps: EvaluatorDeps): EvaluatorService {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  async function loadBusiness(businessId: string) {
    if (!deps.businesses) return null;
    try {
      const business = await deps.businesses.getBusiness(businessId);
      return {
        point: { lat: business.locations.primary.lat, lon: business.locations.primary.lon },
        // The one scores are built from, not an unverified newer one
        latestSnapshotVersion: business.scoring_snapshot?.version ?? null,
      };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async function fetchClimate(point: LatLon, requesterId: string | null): Promise<ClimateResult> {
    try {
      return { status: "ok", profile: await deps.climate.getProfile(point, requesterId) };
    } catch (error) {
      logger.warn("evaluator: climate profile failed", message(error));
      return { status: "unavailable", error: message(error) };
    }
  }

  // The stored profile while it is current, otherwise a new one
  async function fetchFinance(
    businessId: string,
    latestSnapshotVersion: number | null,
    requesterId: string | null,
  ): Promise<{ result: FinanceResult; id: number | null; origin: FinanceSummary["origin"] }> {
    const { finance } = deps;
    if (!finance) return { result: { status: "not_applicable" }, id: null, origin: "computed" };
    try {
      const stored = await finance.latestProfile(businessId);
      const fresh =
        stored !== null &&
        stored.profile.model_version === FINANCE.modelVersion &&
        stored.profile.inputs.snapshot_version === latestSnapshotVersion &&
        now().getTime() - stored.createdAt.getTime() < EVALUATOR.financeMaxAgeHours * HOUR_MS;
      if (stored && fresh) return { result: { status: "ok", profile: stored.profile }, id: stored.id, origin: "reused" };

      const profile = await finance.getFinanceProfile(businessId, { trigger: "request", requesterId });
      const saved = await finance.latestProfile(businessId);
      const id = saved?.profile.generated_at === profile.generated_at ? saved.id : null;
      return { result: { status: "ok", profile }, id, origin: "computed" };
    } catch (error) {
      // No snapshot yet, for example
      logger.warn("evaluator: finance profile failed", message(error));
      return { result: { status: "unavailable", error: message(error) }, id: null, origin: "computed" };
    }
  }

  function summarise(profile: FinanceProfile, id: number | null, origin: FinanceSummary["origin"]): FinanceSummary {
    return {
      profile_id: id,
      generated_at: profile.generated_at,
      origin,
      snapshot_version: profile.inputs.snapshot_version,
      baseline_score: profile.baseline.score,
      baseline_band: profile.baseline.band,
      adjusted_score: profile.adjusted?.score ?? null,
      adjusted_band: profile.adjusted?.band ?? null,
      dscr: profile.metrics.dscr,
      cash_runway_months: profile.metrics.cash_runway_months,
      breached_hazards: breachedHazards(profile),
      drivers: profile.adjusted?.drivers ?? [],
      summary: profile.summary,
    };
  }

  return {
    async evaluate({ businessId, point, requesterId = null }) {
      const business = await loadBusiness(businessId);
      const where = business?.point ?? point;
      if (!where) throw new NotFoundError(`Business ${businessId} not found`);

      // Climate first: the finance profile asks the climate unit too, and
      // then finds the cell already cached
      const climate = await fetchClimate(where, requesterId);
      const finance = business
        ? await fetchFinance(businessId, business.latestSnapshotVersion, requesterId)
        : { result: { status: "not_applicable" } as FinanceResult, id: null, origin: "computed" as const };

      const checks = runChecks({
        climate,
        finance: finance.result,
        latestSnapshotVersion: business?.latestSnapshotVersion ?? null,
        now: now(),
      });
      const climateProfile = climate.status === "ok" ? climate.profile : null;
      const financeProfile = finance.result.status === "ok" ? finance.result.profile : null;

      const checked = evaluationSchema.safeParse({
        evaluation_id: null,
        business_id: businessId,
        generated_at: toIstIso(now()),
        evaluator_version: EVALUATOR.version,
        rating: combinedRating(checks, climateProfile, financeProfile),
        reliable: !checks.some((check) => check.status === "fail"),
        reasons: reasons(checks, climateProfile, financeProfile),
        checks,
        // A profile that failed its own schema is reported by its check, not passed on
        climate: checks.some((c) => c.id === "climate_schema" && c.status === "fail") ? null : climateProfile,
        finance: financeProfile ? summarise(financeProfile, finance.id, finance.origin) : null,
      });
      if (!checked.success) {
        logger.error("evaluator: evaluation failed output validation", checked.error.issues);
        throw new AppError("Generated evaluation failed validation", 500, "INVALID_OUTPUT", undefined, "output_validation");
      }
      const evaluation = checked.data;

      if (deps.store) {
        try {
          evaluation.evaluation_id = await deps.store.save({
            evaluation,
            requesterId,
            financeProfileId: finance.id,
            climateRef: climateProfile ? climateRunRef(climateProfile) : null,
          });
        } catch (error) {
          logger.error("evaluator: saving the evaluation failed", message(error));
        }
      }
      return evaluation;
    },

    history(businessId, limit = 20) {
      return deps.store ? deps.store.list(businessId, limit) : Promise.resolve([]);
    },
  };
}
