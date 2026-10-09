import type { ClimateProfile } from "../../climate/schema.js";
import { invalidOutput } from "../errors.js";
import type { FinanceMetrics } from "../metrics/compute.js";
import type { AdjustedScore } from "../scoring/adjusted.js";
import type { ScoreResult } from "../scoring/baseline.js";
import type { HazardSensitivities, SensitivitySource } from "../scoring/sensitivity.js";
import type { StressResults } from "../scoring/stress.js";
import { financeProfileSchema, type FinanceProfile } from "./schema.js";

const IST_OFFSET_MS = 5.5 * 3_600_000;

// Timestamps leave the API in India time
export const toIstIso = (date: Date) =>
  `${new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

export type ClimateRef = NonNullable<FinanceProfile["climate"]>;

// What the finance profile keeps of a climate profile. The profile itself
// is the climate unit's to store; this points back at it.
export function climateRef(climate: ClimateProfile, fetchedAt: Date): ClimateRef {
  const cellId = climate.location.cells.forecast;
  const run =
    climate.data_freshness.forecast_issued_at ??
    climate.data_freshness.history_until ??
    toIstIso(fetchedAt);
  return {
    profile_ref: `${cellId}@${run}`,
    cell_id: cellId,
    fetched_at: toIstIso(fetchedAt),
    overall_climate_risk: climate.overall_climate_risk,
    grade: climate.grade,
    confidence: climate.confidence,
  };
}

// What every scoring run produces, with or without a stored business
export interface Assessment {
  metrics: FinanceMetrics;
  baseline: ScoreResult;
  climate: ClimateRef | null;
  sensitivity: { source: SensitivitySource; hazards: HazardSensitivities };
  stress: StressResults | Record<string, never>;
  adjusted: AdjustedScore | null;
  warnings: string[];
}

// One line built from the numbers, never from the classifier's wording
export function assessmentSummary(assessment: Pick<Assessment, "baseline" | "adjusted">): string {
  const { baseline, adjusted } = assessment;
  const base = `Baseline ${String(baseline.score)} (${baseline.band})`;
  if (!adjusted) return `${base}. Climate data is unavailable, so there is no climate-adjusted score.`;
  const top = adjusted.drivers[0];
  return (
    `${base}; climate-adjusted ${String(adjusted.score)} (${adjusted.band}). ` +
    (top ? `Biggest driver: ${top.reason}.` : "No hazard moves the score.")
  );
}

export interface ProfileParts extends Assessment {
  businessId: string;
  generatedAt: Date;
  modelVersion: string;
  inputs: FinanceProfile["inputs"];
}

// Assembles the response and checks it against the output schema
export function buildProfile(parts: ProfileParts): FinanceProfile {
  const result = financeProfileSchema.safeParse({
    business_id: parts.businessId,
    generated_at: toIstIso(parts.generatedAt),
    model_version: parts.modelVersion,
    inputs: parts.inputs,
    baseline: parts.baseline,
    metrics: parts.metrics,
    climate: parts.climate,
    sensitivity: parts.sensitivity,
    stress: parts.stress,
    adjusted: parts.adjusted,
    summary: assessmentSummary(parts),
    warnings: parts.warnings,
  });
  if (!result.success) throw invalidOutput(result.error.issues);
  return result.data;
}
