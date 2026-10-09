import { z } from "zod";
import { HAZARDS } from "../climate/types.js";
import { ML } from "./config.js";

// What the UI may send to /ml. Strict, so a typo is refused here and not
// silently dropped on the way to the Python service.

const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const hazard = z.enum(HAZARDS);
const share = z.number().min(0).max(1);
const daily = z.array(z.number()).min(1).max(ML.weatherMaxDays);

export const calibrateAlertSchema = z.strictObject({
  hazard: z.enum(["flood", "storm"]),
  lat,
  lon,
  date: isoDate,
  // Daily values ending on the alert day, oldest first
  precipitation_sum: z.array(z.number().min(0)).min(1).max(ML.weatherMaxDays),
  soil_wetness_top: daily.optional(),
  relative_humidity_2m_mean: daily.optional(),
  // Storm needs both; without them the answer is the rule's base rate
  wind_speed_10m_max: daily.optional(),
  surface_pressure_mean: daily.optional(),
});

export const anomalySchema = z
  .strictObject({
    // Monthly revenue ending on the latest month, oldest first
    monthly_revenue: z.array(z.number().min(0)).min(ML.anomaly.minMonths).max(ML.anomaly.maxMonths),
    late_payments: z.array(z.boolean()).optional(),
    cell_anomalous_share: share.optional(),
    climate_event_in_cell: z.boolean().optional(),
  })
  .refine((body) => !body.late_payments || body.late_payments.length === body.monthly_revenue.length, {
    message: "late_payments must be as long as monthly_revenue",
    path: ["late_payments"],
  });

export const climateCashflowSchema = z
  .strictObject({
    lat,
    lon,
    monthly_revenue: z.number().positive(),
    variable_cost_share: z.number().min(0).max(0.95),
    fixed_costs: z.number().min(0),
    emi: z.number().min(0),
    starting_cash: z.number().min(0),
    revenue_volatility: share.optional(),
    sector: z.string().min(1).max(40).optional(),
    // 0-1 per hazard; without it the sector's defaults are used
    vulnerability: z.partialRecord(hazard, share).optional(),
    insurance_recovery: share.optional(),
    backup_power: z.boolean().optional(),
    date: isoDate.optional(),
    // The scorecard's base PD, to get a climate-adjusted PD back
    pd_base: share.optional(),
    alert_hazard: hazard.optional(),
    alert_p_event: share.optional(),
  })
  .refine((body) => body.sector !== undefined || body.vulnerability !== undefined, {
    message: "send a sector or a vulnerability",
    path: ["sector"],
  })
  .refine((body) => (body.alert_hazard === undefined) === (body.alert_p_event === undefined), {
    message: "alert_hazard and alert_p_event go together",
    path: ["alert_p_event"],
  });

export type CalibrateAlertBody = z.infer<typeof calibrateAlertSchema>;
export type AnomalyBody = z.infer<typeof anomalySchema>;
export type ClimateCashflowBody = z.infer<typeof climateCashflowSchema>;

// What the Python service answers. Unknown keys are dropped, so the UI only
// ever sees the fields listed here.

export const alertCalibrationSchema = z.object({
  p_event: z.number().nullable(),
  band: z.enum(["low", "medium", "high", "baseline", "unscored"]),
  model_version: z.string(),
  cell: z.string().nullable().optional(),
  distance_km: z.number().nullable().optional(),
  reason: z.string().nullable().optional(),
});

export const anomalyResultSchema = z.object({
  anomaly_score: z.number().nullable(),
  flagged: z.boolean(),
  type: z.enum(["systemic", "idiosyncratic"]).nullable().optional(),
  months_flagged: z.number(),
  model_version: z.string(),
  reason: z.string().nullable().optional(),
});

const whatIf = z.object({ condition: z.string(), pd_with_climate: z.number(), pd_change: z.number() });
const hazardRate = z.object({ events_per_year: z.number(), mean_duration: z.number() });

export const climateCashflowResultSchema = z.union([
  z.object({
    scored: z.literal(true),
    cell: z.string(),
    distance_km: z.number(),
    pd_without_climate: z.number(),
    pd_with_climate: z.number(),
    delta_pd_climate: z.number(),
    climate_adjusted_pd: z.number().optional(),
    climate_premium_bps: z.number(),
    expected_annual_climate_loss: z.number(),
    climate_cfar95: z.number(),
    cash_reserve_target: z.number(),
    p_cash_short_30d: z.number(),
    p_cash_short_30d_without_climate: z.number(),
    loss_by_hazard: z.record(z.string(), z.number()),
    what_if: z.array(whatIf),
    paths: z.number(),
    hazards: z.record(z.string(), hazardRate),
    assumptions: z.array(z.string()),
  }),
  z.object({
    scored: z.literal(false),
    reason: z.string(),
    cell: z.string().optional(),
    distance_km: z.number().optional(),
  }),
]);

export const mlHealthSchema = z.object({
  status: z.string(),
  models: z.record(z.string(), z.boolean()),
  hazard_params: z.boolean().optional(),
});

export type AlertCalibration = z.infer<typeof alertCalibrationSchema>;
export type AnomalyResult = z.infer<typeof anomalyResultSchema>;
export type ClimateCashflowResult = z.infer<typeof climateCashflowResultSchema>;
