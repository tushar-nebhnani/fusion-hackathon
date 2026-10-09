import { z } from "zod";
import { HAZARDS, type Hazard } from "../climate/types.js";

export { HAZARDS, type Hazard };

export const LOAN_STATES = ["PRE_LOAN", "ACTIVE", "ALERT", "IMPACTED", "RECOVERY"] as const;
export type LoanStateName = (typeof LOAN_STATES)[number];

export type AdvisorMode = "preLoan" | "alert" | "recovery";

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;
export type MonthName = (typeof MONTHS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ── Business data (finance stub + input-service stub, see NOTES.md) ──────────

export const WEATHER_EFFECTS = ["favourable", "unfavourable", "neutral"] as const;

export const weatherImpactEntrySchema = z.object({
  effect: z.enum(WEATHER_EFFECTS),
  // 0-1: share of normal revenue lost on a day the hazard hits
  sensitivity: z.number().min(0).max(1),
  reason: z.string(),
});
export type WeatherImpactEntry = z.infer<typeof weatherImpactEntrySchema>;

export const loanRecordSchema = z.object({
  loanId: z.string().min(1),
  principal: z.number().positive(),
  annualRatePct: z.number().min(0).max(60),
  tenureMonths: z.number().int().positive(),
  // Null while the loan is only requested
  disbursedOn: isoDate.nullable(),
  // State the loan starts in when the advisor first sees it
  initialState: z.enum(LOAN_STATES).default("PRE_LOAN"),
});
export type LoanRecord = z.infer<typeof loanRecordSchema>;

export const businessRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  ownerName: z.string(),
  sector: z.string(),
  description: z.string(),
  city: z.string(),
  state: z.string(),
  lat: z.number(),
  lon: z.number(),
  contacts: z.object({
    ownerEmail: z.string().nullable(),
    ownerPhone: z.string().nullable(),
    bankEmail: z.string().nullable(),
    // Demo contacts only; contacts in alert_contacts take precedence
    consent: z.boolean(),
  }),
  finance: z.object({
    // Jan..Dec, INR
    monthlyRevenue: z.array(z.number().nonnegative()).length(12),
    // Share of revenue that is cost of goods sold, so a lost sale also saves it
    variableCostShare: z.number().min(0).max(1),
    fixedMonthlyCosts: z.number().nonnegative(),
    // EMIs on debt other than the loans listed below
    otherDebtMonthly: z.number().nonnegative(),
  }),
  loans: z.array(loanRecordSchema),
  // Facts captured by the onboarding form (stored with source "form")
  formFacts: z.record(z.string(), z.string()).default({}),
  // Output of the input service's weather-impact classifier, when it has run
  weatherImpact: z.partialRecord(z.enum(HAZARDS), weatherImpactEntrySchema).optional(),
});
export type BusinessRecord = z.infer<typeof businessRecordSchema>;

// ── Alerts ────────────────────────────────────────────────────────────────────

// README §5 Mode 2. `hazard` is the monitor's name; see hazardFromAlert()
export const advisorAlertEventSchema = z.object({
  alertId: z.string().min(1).max(100),
  cellId: z.string().min(1).max(100),
  hazard: z.string().min(1).max(40),
  severity: z.enum(["watch", "warning", "severe"]),
  windowStart: z.iso.datetime({ offset: true }),
  windowEnd: z.iso.datetime({ offset: true }),
  loanIds: z.array(z.string().min(1)).min(1).max(500),
});
export type AdvisorAlertEvent = z.infer<typeof advisorAlertEventSchema>;

// Monitor hazard names that are not one of the climate unit's six
const HAZARD_ALIASES: Record<string, Hazard> = {
  heavy_rain: "flash_flood",
  rain: "flash_flood",
  flood: "river_flood",
  cyclone: "storm",
  wind: "storm",
  heatwave: "heat",
  heat_wave: "heat",
  cold: "cold_wave",
};

export function hazardFromAlert(name: string): Hazard | null {
  const key = name.trim().toLowerCase();
  if ((HAZARDS as readonly string[]).includes(key)) return key as Hazard;
  return HAZARD_ALIASES[key] ?? null;
}

// ── Damage (Mode 3) ───────────────────────────────────────────────────────────

export const insuranceClaimSchema = z.object({
  status: z.enum(["none", "planned", "filed", "approved"]),
  expectedAmountInr: z.number().nonnegative().optional(),
  // Date the payout is expected
  expectedDate: isoDate.optional(),
});

export const damageSchema = z.object({
  hazard: z.enum(HAZARDS).optional(),
  daysClosed: z.number().int().min(0).max(365).optional(),
  stockLossInr: z.number().nonnegative().optional(),
  equipmentDamageInr: z.number().nonnegative().optional(),
  expectedReopenDate: isoDate.optional(),
  insuranceClaim: insuranceClaimSchema.optional(),
  // The cash-flow projection starts in the month after this date
  reportedOn: isoDate.optional(),
});
export type Damage = z.infer<typeof damageSchema>;

export const REQUIRED_DAMAGE_FIELDS = [
  "daysClosed",
  "stockLossInr",
  "equipmentDamageInr",
  "expectedReopenDate",
  "insuranceClaim",
] as const;

export function missingDamageFields(damage: Damage): string[] {
  const missing: string[] = REQUIRED_DAMAGE_FIELDS.filter((key) => damage[key] === undefined);
  const claim = damage.insuranceClaim;
  if (claim && (claim.status === "filed" || claim.status === "approved")) {
    if (claim.expectedAmountInr === undefined) missing.push("insuranceClaim.expectedAmountInr");
    if (claim.expectedDate === undefined) missing.push("insuranceClaim.expectedDate");
  }
  return missing;
}

// ── Facts the pre-loan advisor fills in (README §5 Mode 1 step 2) ─────────────

// In the order they are asked: the first ones change flood losses the most
export const RISK_FACT_KEYS = [
  "stock_perishable",
  "storage_level",
  "insurance",
  "revenue_pattern",
  "road_power_dependency",
] as const;
export type RiskFactKey = (typeof RISK_FACT_KEYS)[number];

export type FactSource = "owner_chat" | "form" | "bank";

export interface BusinessFactView {
  key: string;
  value: string;
  source: FactSource;
  updatedAt: string;
}
