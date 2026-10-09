import type { Hazard } from "../../climate/types.js";
import { FINANCE } from "../config.js";
import { round, type FinanceMetrics } from "../metrics/compute.js";
import { baselineScore, riskBand, type RiskBand, type ScoreResult } from "./baseline.js";
import type { HazardStress } from "./stress.js";

// The climate-adjusted score: the baseline less a penalty per hazard, each
// in proportion to how far that hazard's stress test pushes the business.

export interface Driver {
  hazard: Hazard;
  // Points added to the baseline; below zero is a penalty
  points_change: number;
  reason: string;
}

export interface AdjustedScore {
  score: number;
  band: RiskBand;
  drivers: Driver[];
}

const rupees = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;

export function hazardLabel(hazard: Hazard): string {
  const text = hazard.replace("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Points a hazard moves the score by, before hazards are combined. Above
// zero is a penalty.
export function hazardPoints(metrics: FinanceMetrics, stress: HazardStress): number {
  const shock = stress.shock_pct / 100;
  const perShock = FINANCE.adjusted.pointsPerShock * Math.abs(shock);
  if (shock >= 0) return -perShock;

  // How far the rule-based score falls on the stressed DSCR and runway
  const fall =
    baselineScore(metrics).score -
    baselineScore({
      ...metrics,
      dscr: stress.stressed_metrics.dscr,
      cash_runway_months: stress.stressed_metrics.cash_runway_months,
    }).score;
  return perShock + FINANCE.adjusted.rescoreWeight * Math.max(0, fall);
}

// Built from the numbers alone; the classifier's wording is never used here
export function driverReason(hazard: Hazard, metrics: FinanceMetrics, stress: HazardStress): string {
  const label = hazardLabel(hazard);
  const size = `${String(Math.abs(stress.shock_pct))}%`;
  const severity = `severity ${String(stress.severity)}`;
  if (stress.shock_pct > 0) return `${label} conditions (${severity}) lift revenue by ${size}`;

  const after = stress.stressed_metrics;
  const effect =
    metrics.dscr !== null && after.dscr !== null
      ? `drops DSCR from ${String(round(metrics.dscr, 2))} to ${String(round(after.dscr, 2))}`
      : `cuts monthly cashflow from ${rupees(metrics.net_monthly_cashflow)} to ${rupees(after.net_monthly_cashflow)}`;
  const cash =
    after.cash_runway_months === null
      ? ""
      : `, leaving ${String(after.cash_runway_months)} months of cash`;
  const insured =
    stress.insurance_applied.length > 0
      ? ` after ${stress.insurance_applied.join(" and ")} insurance`
      : "";
  return `${label} stress (${severity}, revenue down ${size}${insured}) ${effect}${cash}`;
}

export function adjustScore(
  baseline: ScoreResult,
  metrics: FinanceMetrics,
  stress: Partial<Record<Hazard, HazardStress>>,
): AdjustedScore {
  const { stackDecay, maxUplift } = FINANCE.adjusted;
  const entries = (Object.entries(stress) as [Hazard, HazardStress][]).map(([hazard, result]) => ({
    hazard,
    result,
    points: hazardPoints(metrics, result),
  }));

  // Worst first; each further hazard counts for less
  const penalties = entries.filter((entry) => entry.points > 0).sort((a, b) => b.points - a.points);
  const gains = entries.filter((entry) => entry.points < 0);
  const totalGain = gains.reduce((sum, entry) => sum - entry.points, 0);
  const gainScale = totalGain > maxUplift ? maxUplift / totalGain : 1;

  const changes = [
    ...penalties.map((entry, index) => ({ ...entry, change: -entry.points * stackDecay ** index })),
    ...gains.map((entry) => ({ ...entry, change: -entry.points * gainScale })),
  ];
  const total = changes.reduce((sum, entry) => sum + entry.change, 0);
  const ceiling = Math.min(100, baseline.score + maxUplift);
  const score = Math.round(Math.min(ceiling, Math.max(0, baseline.score + total)));

  return {
    score,
    band: riskBand(score),
    drivers: changes
      .map((entry) => ({
        hazard: entry.hazard,
        points_change: round(entry.change, 1),
        reason: driverReason(entry.hazard, metrics, entry.result),
      }))
      .filter((driver) => driver.points_change !== 0)
      .sort((a, b) => Math.abs(b.points_change) - Math.abs(a.points_change)),
  };
}
