import { z } from "zod";
import { HAZARDS, type Hazard } from "../../climate/types.js";
import { INSURANCE_COVERS } from "../../input/schemas/index.js";
import { CHANNELS } from "../scoring/sensitivity.js";

// The finance profile (README section 6). Every profile is checked against
// this before it leaves; the schema is strict, so an extra key fails.

function perHazard<Schema extends z.ZodType>(schema: Schema) {
  return {
    river_flood: schema,
    flash_flood: schema,
    heat: schema,
    drought: schema,
    storm: schema,
    cold_wave: schema,
  } satisfies Record<Hazard, Schema>;
}

const unit = z.number().min(0).max(1);
const score = z.number().int().min(0).max(100);
const band = z.enum(["low_risk", "moderate", "high", "critical"]);
const direction = z.enum(["unfavourable", "favourable", "neutral"]);
const cashRunway = z.enum(["positive_cashflow", "burning"]);

export const baselineSchema = z.strictObject({
  score,
  band,
  sub_scores: z.strictObject({
    dscr: score,
    runway: score,
    leverage: score,
    volatility: score,
    repayment: score,
    business_age: score,
  }),
  source: z.enum(["rules", "ml"]),
});

export const metricsSchema = z.strictObject({
  months_of_history: z.number().int().min(1),
  avg_monthly_revenue: z.number().min(0),
  avg_monthly_expenses: z.number().min(0),
  net_monthly_cashflow: z.number(),
  existing_emi: z.number().min(0),
  proposed_emi: z.number().min(0),
  total_emi: z.number().min(0),
  dscr: z.number().nullable(),
  surplus_after_debt: z.number(),
  cash_reserves: z.number().min(0),
  cash_runway: cashRunway,
  cash_runway_months: z.number().min(0).nullable(),
  cash_buffer_months: z.number().min(0).nullable(),
  revenue_volatility: z.number().min(0),
  seasonality_index: z.number().min(0),
  leverage: z.number().min(0),
  repayment_record: z.strictObject({
    missed_payments_12m: z.number().int().min(0),
    rating: z.enum(["clean", "minor", "watch", "poor"]),
  }),
  years_in_operation: z.number().int().min(0),
});

export const sensitivitySchema = z.strictObject({
  source: z.enum(["llm", "fallback", "override"]),
  hazards: z.strictObject(
    perHazard(
      z.strictObject({
        direction,
        magnitude: unit,
        channels: z.array(z.enum(CHANNELS)),
        reason: z.string(),
        physical: unit,
        demand: z.number().min(-1).max(1),
      }),
    ),
  ),
});

export const hazardStressSchema = z.strictObject({
  severity: unit,
  direction,
  shock_pct: z.number().min(-100).max(100),
  gross_shock_pct: z.number().min(-100).max(100),
  insurance_applied: z.array(z.enum(INSURANCE_COVERS)),
  duration_months: z.number().int().min(1),
  stressed_metrics: z.strictObject({
    monthly_revenue: z.number().min(0),
    net_monthly_cashflow: z.number(),
    dscr: z.number().nullable(),
    surplus_after_debt: z.number(),
    cash_runway: cashRunway,
    cash_runway_months: z.number().min(0).nullable(),
    cash_after_shock: z.number(),
  }),
  breach: z.boolean(),
  breach_reasons: z.array(z.string()),
});

export const adjustedSchema = z.strictObject({
  score,
  band,
  drivers: z.array(
    z.strictObject({
      hazard: z.enum(HAZARDS),
      points_change: z.number(),
      reason: z.string(),
    }),
  ),
});

export const climateRefSchema = z.strictObject({
  // The forecast cell and the forecast run the stress test was computed from
  profile_ref: z.string(),
  cell_id: z.string(),
  fetched_at: z.string(),
  overall_climate_risk: unit,
  grade: z.enum(["A", "B", "C", "D", "E"]),
  confidence: z.enum(["low", "med", "high"]),
});

export const financeProfileSchema = z.strictObject({
  business_id: z.string(),
  generated_at: z.string(),
  model_version: z.string(),
  // Which stored records the numbers below were computed from
  inputs: z.strictObject({
    snapshot_version: z.number().int().min(1),
    snapshot_as_of: z.string(),
    snapshot_verified: z.boolean(),
    proposed_loan_ids: z.array(z.string()),
    impact_profile_version: z.number().int().nullable(),
  }),
  baseline: baselineSchema,
  metrics: metricsSchema,
  // null, with an empty `stress` and a null `adjusted`, when the climate
  // unit could not answer
  climate: climateRefSchema.nullable(),
  sensitivity: sensitivitySchema,
  stress: z.union([z.strictObject(perHazard(hazardStressSchema)), z.strictObject({})]),
  adjusted: adjustedSchema.nullable(),
  // One line built from the numbers above, for an agent or a list view
  summary: z.string(),
  warnings: z.array(z.string()),
});

export type FinanceProfile = z.infer<typeof financeProfileSchema>;
