import { z } from "zod";
import { climateProfileSchema } from "../climate/schema.js";
import { HAZARDS } from "../climate/types.js";
import { RATINGS } from "./config.js";

// The evaluation, checked before it leaves like the climate and finance
// profiles. Strict: an extra key fails.

export const CHECK_IDS = [
  "climate_available",
  "climate_schema",
  "climate_confidence",
  "forecast_fresh",
  "finance_available",
  "finance_schema",
  "finance_current",
  "snapshot_verified",
  "same_location",
  "same_climate_run",
  "stress_coverage",
  "adjustment_cap",
] as const;

const check = z.strictObject({
  id: z.enum(CHECK_IDS),
  // fail: the response cannot be relied on; warn: usable, with a caveat;
  // skip: does not apply (no finance profile for a demo business)
  status: z.enum(["pass", "warn", "fail", "skip"]),
  detail: z.string(),
});
export type Check = z.infer<typeof check>;

const band = z.enum(["low_risk", "moderate", "high", "critical"]);

export const financeSummarySchema = z.strictObject({
  profile_id: z.number().int().nullable(),
  generated_at: z.string(),
  // reused: a stored profile; computed: built for this evaluation
  origin: z.enum(["reused", "computed"]),
  snapshot_version: z.number().int(),
  baseline_score: z.number().int(),
  baseline_band: band,
  adjusted_score: z.number().int().nullable(),
  adjusted_band: band.nullable(),
  dscr: z.number().nullable(),
  cash_runway_months: z.number().nullable(),
  breached_hazards: z.array(z.enum(HAZARDS)),
  drivers: z.array(z.strictObject({ hazard: z.enum(HAZARDS), points_change: z.number(), reason: z.string() })),
  summary: z.string(),
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

export const evaluationSchema = z.strictObject({
  // null when it was not stored
  evaluation_id: z.number().int().nullable(),
  business_id: z.string(),
  generated_at: z.string(),
  evaluator_version: z.string(),
  rating: z.enum(RATINGS),
  // false when any check failed: neither the rating nor the figures below
  // should be used then
  reliable: z.boolean(),
  reasons: z.array(z.string()),
  checks: z.array(check),
  climate: climateProfileSchema.nullable(),
  finance: financeSummarySchema.nullable(),
});
export type Evaluation = z.infer<typeof evaluationSchema>;
