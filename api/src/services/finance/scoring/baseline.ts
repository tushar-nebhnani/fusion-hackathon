import { FINANCE, type Banding, type SubScoreName } from "../config.js";
import type { FinanceMetrics } from "../metrics/compute.js";

// The rule-based baseline: six banded sub-scores, weighted into one score
// from 0 to 100 where higher is healthier. Weights and bands are in
// `FINANCE.baseline` (config.ts), so they can be tuned without touching this.

export type RiskBand = "low_risk" | "moderate" | "high" | "critical";
export type SubScores = Record<SubScoreName, number>;

export interface ScoreResult {
  score: number;
  band: RiskBand;
  sub_scores: SubScores;
  source: "rules" | "ml";
}

// The metrics the score reads. The stress test re-scores a business by
// swapping in its stressed DSCR and runway.
export type ScoredMetrics = Pick<
  FinanceMetrics,
  | "dscr"
  | "cash_runway_months"
  | "cash_buffer_months"
  | "leverage"
  | "revenue_volatility"
  | "repayment_record"
  | "years_in_operation"
>;

export function bandScore(banding: Banding, value: number): number {
  if ("atLeast" in banding) {
    for (const [threshold, score] of banding.atLeast) if (value >= threshold) return score;
  } else {
    for (const [threshold, score] of banding.atMost) if (value <= threshold) return score;
  }
  return banding.otherwise;
}

export function riskBand(score: number): RiskBand {
  for (const [band, lowest] of FINANCE.baseline.riskBands) if (score >= lowest) return band;
  return "critical";
}

// A business burning cash is scored on how long the cash lasts; one that
// is not, on how many months of outgoings it holds in reserve
function runwayScore(metrics: ScoredMetrics): number {
  const { bands } = FINANCE.baseline;
  if (metrics.cash_runway_months !== null) return bandScore(bands.runway, metrics.cash_runway_months);
  return metrics.cash_buffer_months === null ? 100 : bandScore(bands.buffer, metrics.cash_buffer_months);
}

export function subScores(metrics: ScoredMetrics): SubScores {
  const { bands } = FINANCE.baseline;
  return {
    dscr:
      metrics.dscr === null
        ? FINANCE.baseline.noDebtDscrScore
        : bandScore(bands.dscr, metrics.dscr),
    runway: runwayScore(metrics),
    leverage: bandScore(bands.leverage, metrics.leverage),
    volatility: bandScore(bands.volatility, metrics.revenue_volatility),
    repayment: bandScore(bands.repayment, metrics.repayment_record.missed_payments_12m),
    business_age: bandScore(bands.business_age, metrics.years_in_operation),
  };
}

export function weightedScore(scores: SubScores): number {
  const { weights } = FINANCE.baseline;
  let total = 0;
  for (const name of Object.keys(weights) as SubScoreName[]) total += weights[name] * scores[name];
  return total;
}

export function baselineScore(metrics: ScoredMetrics): ScoreResult {
  const scores = subScores(metrics);
  const score = Math.round(weightedScore(scores));
  return { score, band: riskBand(score), sub_scores: scores, source: "rules" };
}
