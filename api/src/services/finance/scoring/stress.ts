import { HAZARDS, type Hazard } from "../../climate/types.js";
import type { Operations, Sector } from "../../input/schemas/index.js";
import { FINANCE } from "../config.js";
import { debtCover, round, type FinanceMetrics } from "../metrics/compute.js";
import type { Direction, HazardSensitivities, HazardSensitivity } from "./sensitivity.js";

// The climate stress test: what a hazard of a given severity does to this
// business's revenue, and what is left of its debt cover and cash.

export type InsuranceCover = NonNullable<Operations["insurance_covers"]>[number];

export interface StressContext {
  sector: Sector;
  // Empty when the business is not insured
  insuranceCovers: readonly InsuranceCover[];
  durationMonths?: number;
}

export interface StressedMetrics {
  monthly_revenue: number;
  net_monthly_cashflow: number;
  dscr: number | null;
  surplus_after_debt: number;
  cash_runway: "positive_cashflow" | "burning";
  // Months the cash would last if the shock did not end
  cash_runway_months: number | null;
  // Cash left once the shock has run its `duration_months`
  cash_after_shock: number;
}

export interface HazardStress {
  // The hazard's strength, 0 to 1
  severity: number;
  direction: Direction;
  // Change in monthly revenue, in percent; below zero is a loss
  shock_pct: number;
  // The same before insurance and the favourable cap
  gross_shock_pct: number;
  insurance_applied: InsuranceCover[];
  duration_months: number;
  stressed_metrics: StressedMetrics;
  breach: boolean;
  breach_reasons: string[];
}

export type StressResults = Record<Hazard, HazardStress>;

// The covers this business holds that answer for `hazard`
export function matchingCovers(hazard: Hazard, context: StressContext): InsuranceCover[] {
  const { covers, cropSectors } = FINANCE.stress.insurance;
  return context.insuranceCovers.filter((cover) => {
    if (cover === "crop" && !(cropSectors as readonly Sector[]).includes(context.sector)) return false;
    return (covers[cover] as readonly Hazard[]).includes(hazard);
  });
}

// Revenue change as a share: severity times the business's sensitivity,
// less what insurance takes off a loss, and capped when it is a gain
export function revenueShock(
  severity: number,
  sensitivity: HazardSensitivity,
  insured: boolean,
): { gross: number; shock: number } {
  const sign = sensitivity.direction === "favourable" ? 1 : sensitivity.direction === "unfavourable" ? -1 : 0;
  // `+ 0` turns the -0 of a zero severity into 0
  const gross = Math.min(1, Math.max(0, severity)) * sensitivity.magnitude * sign + 0;
  if (gross > 0) return { gross, shock: Math.min(gross, FINANCE.stress.favourableCap) };
  if (gross === 0 || !insured) return { gross, shock: gross };

  // Insurance pays for damage and downtime, not for customers staying away
  const lostDemand = Math.max(0, -sensitivity.demand);
  const physicalShare =
    sensitivity.physical + lostDemand > 0 ? sensitivity.physical / (sensitivity.physical + lostDemand) : 1;
  return { gross, shock: gross * (1 - FINANCE.stress.insurance.coverShare * physicalShare) };
}

export function stressHazard(
  metrics: FinanceMetrics,
  hazard: Hazard,
  severity: number,
  sensitivity: HazardSensitivity,
  context: StressContext,
): HazardStress {
  const duration = context.durationMonths ?? FINANCE.stress.durationMonths;
  const covers = matchingCovers(hazard, context);
  const { gross, shock } = revenueShock(severity, sensitivity, covers.length > 0);
  const revenue = metrics.avg_monthly_revenue * (1 + shock);
  const cover = debtCover({
    revenue,
    expenses: metrics.avg_monthly_expenses,
    totalEmi: metrics.total_emi,
    cash: metrics.cash_reserves,
  });

  const { breach } = FINANCE.stress;
  const reasons: string[] = [];
  if (cover.dscr !== null && cover.dscr < breach.dscrBelow) {
    reasons.push(`dscr_below_${String(breach.dscrBelow)}`);
  }
  if (cover.cash_runway_months !== null && cover.cash_runway_months < breach.runwayMonthsBelow) {
    reasons.push(`runway_below_${String(breach.runwayMonthsBelow)}_months`);
  }

  return {
    severity: round(severity, 3),
    direction: shock === 0 ? "neutral" : sensitivity.direction,
    shock_pct: round(shock * 100, 2),
    gross_shock_pct: round(gross * 100, 2),
    // Only a loss has anything for insurance to pay
    insurance_applied: gross < 0 ? covers : [],
    duration_months: duration,
    stressed_metrics: {
      monthly_revenue: round(revenue, 2),
      ...cover,
      cash_after_shock: round(
        metrics.cash_reserves + Math.min(0, cover.surplus_after_debt) * duration,
        2,
      ),
    },
    breach: reasons.length > 0,
    breach_reasons: reasons,
  };
}

// One result per hazard. `severities` is each hazard's score from the
// climate profile.
export function stressTest(
  metrics: FinanceMetrics,
  severities: Record<Hazard, number>,
  sensitivities: HazardSensitivities,
  context: StressContext,
): StressResults {
  const results = {} as StressResults;
  for (const hazard of HAZARDS) {
    results[hazard] = stressHazard(metrics, hazard, severities[hazard], sensitivities[hazard], context);
  }
  return results;
}
