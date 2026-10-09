import type { ClimateService } from "../../climate/profile.service.js";
import { climateProfileSchema, type ClimateProfile } from "../../climate/schema.js";
import { HAZARDS, type Hazard } from "../../climate/types.js";
import type { FinanceInputs } from "../metrics/compute.js";
import type { HazardSensitivity } from "../scoring/sensitivity.js";

// A healthy business: average revenue 100,000, DSCR 2.0, baseline score 91
export function financeInputs(overrides: Partial<FinanceInputs> = {}): FinanceInputs {
  const half = [80_000, 90_000, 100_000, 110_000, 120_000, 100_000];
  return {
    monthly_revenue: [...half, ...half],
    monthly_expenses: 60_000,
    existing_emi: 20_000,
    proposed_emi: 0,
    outstanding_debt: 240_000,
    proposed_principal: 0,
    cash_reserves: 90_000,
    missed_payments_12m: 0,
    years_in_operation: 8,
    ...overrides,
  };
}

// Loses 60% of revenue under a severe event: half the business stops and a
// fifth of the remaining customers stay away
export function sensitivity(overrides: Partial<HazardSensitivity> = {}): HazardSensitivity {
  return {
    direction: "unfavourable",
    magnitude: 0.6,
    channels: ["operations", "revenue"],
    reason: "test reason",
    physical: 0.5,
    demand: -0.2,
    ...overrides,
  };
}

// A climate profile with the given hazard scores (0.1 where none is given).
// It is checked against the climate unit's own schema, so a change to that
// contract fails here first.
export function climateProfile(scores: Partial<Record<Hazard, number>> = {}): ClimateProfile {
  return climateProfileSchema.parse({
    location: {
      lat: 19.076,
      lon: 72.8777,
      cells: {
        historical: "0.1:19.1:72.9",
        climate: "0.1:19.1:72.9",
        flood: "0.05:19.1:72.9",
        forecast: "0.1:19.1:72.9",
      },
    },
    overall_climate_risk: 0.4,
    grade: "C",
    confidence: "med",
    hazards: HAZARDS.map((hazard) => ({
      hazard,
      relevance: "primary",
      relevance_method: "static",
      score: scores[hazard] ?? 0.1,
      components: { historical: 0.2, forecast: 0.1 },
      reason: "test",
    })),
    active_events: [],
    data_freshness: { forecast_issued_at: "2026-10-09T11:30:00+05:30", history_until: "2026-10-03" },
    cache: "complete_hit",
    warnings: [],
  });
}

// Stand-in for the climate unit's entry function
export function fakeClimate(scores: Partial<Record<Hazard, number>> = {}) {
  const calls: { lat: number; lon: number }[] = [];
  const state = { failing: false };
  const climate: Pick<ClimateService, "getProfile"> = {
    getProfile(point) {
      calls.push(point);
      return state.failing
        ? Promise.reject(new Error("climate unit down"))
        : Promise.resolve(climateProfile(scores));
    },
  };
  return { climate, calls, state };
}
