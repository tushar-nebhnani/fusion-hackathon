import { z } from "zod";

export const HAZARDS = [
  "river_flood",
  "flash_flood",
  "heat",
  "drought",
  "storm",
  "cold_wave",
] as const;
export type Hazard = (typeof HAZARDS)[number];

// Hazards screened from the 0.1 degree weather history. `river_flood` is
// screened from the 0.05 degree river discharge history instead.
export const WEATHER_HAZARDS = [
  "flash_flood",
  "heat",
  "drought",
  "storm",
  "cold_wave",
] as const;
export type WeatherHazard = (typeof WEATHER_HAZARDS)[number];

export type Relevance = "primary" | "secondary" | "dormant";
export type Severity = "watch" | "warning" | "severe";
export type ConfidenceLevel = "low" | "med" | "high";
export type CacheResult = "complete_hit" | "partial_hit" | "miss";

export interface LatLon {
  lat: number;
  lon: number;
}

export type Series = (number | null)[];

// One upstream block (`daily` or `hourly`): a time axis plus aligned series
export interface TimeSeries {
  time: string[];
  values: Record<string, Series>;
}

export const weatherIndicatorsSchema = z.object({
  years: z.number(),
  historyUntil: z.string().nullable(),
  heatDaysPerYear: z.number(),
  coldDaysPerYear: z.number(),
  stormDaysPerYear: z.number(),
  heavyRainDaysPerYear: z.number(),
  droughtYearShare: z.number(),
  rain3dP95: z.number(),
  rain3dP99: z.number(),
  tmaxP95: z.number(),
  tmaxP99: z.number(),
});
export type WeatherIndicators = z.infer<typeof weatherIndicatorsSchema>;

export const riverIndicatorsSchema = z.object({
  dischargeMedian: z.number(),
  dischargeP95: z.number(),
  dischargeP99: z.number(),
});
export type RiverIndicators = z.infer<typeof riverIndicatorsSchema>;

export interface ProjectionDeltas {
  heatDaysDelta: number | null;
  precipChangePct: number | null;
  soilMoistureChangePct: number | null;
  heavyRainChangePct: number | null;
}

// Shape of `cell_hazard_relevance.indicators`: everything needed to score a
// hazard later without re-reading 30 years of history.
export const storedIndicatorsSchema = z.object({
  weather: weatherIndicatorsSchema.optional(),
  river: riverIndicatorsSchema.nullable().optional(),
  // The "primary" threshold `indicator_value` was judged against
  primaryThreshold: z.number().positive(),
  projectionAdjustment: z.number().min(0).max(1),
  // Set while climate projections are still to be fetched for this cell
  projectionsRetryAt: z.string().optional(),
});
export type StoredIndicators = z.infer<typeof storedIndicatorsSchema>;

export interface HazardProfile {
  hazard: Hazard;
  relevance: Relevance;
  method: "static" | "agent_raised";
  indicatorValue: number | null;
  reason: string;
  indicators: StoredIndicators;
}

export interface StaticFeatures {
  elevationM: number | null;
  relativeElevationM: number | null;
  floodExposureShare: number | null;
}

export interface DetectedEvent {
  hazard: Hazard;
  severity: Severity;
  windowStart: string;
  windowEnd: string;
  confidence: number;
}

// Forecast data sliced to the event window, ready for scoring
export interface CurrentData {
  weather: TimeSeries | null;
  flood: TimeSeries | null;
}
