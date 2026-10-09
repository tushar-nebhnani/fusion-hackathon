import { CLIMATE } from "../../config/climate.js";
import { LIMITS } from "./hazards.js";
import { mean, rollingSum } from "./stats.js";
import type {
  ConfidenceLevel,
  CurrentData,
  DetectedEvent,
  Hazard,
  HazardProfile,
  ProjectionDeltas,
  Relevance,
  Series,
  Severity,
  StaticFeatures,
  TimeSeries,
} from "./types.js";

export type Grade = "A" | "B" | "C" | "D" | "E";

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// 0 at `low`, 1 at `high`, linear in between
const ramp = (value: number, low: number, high: number) =>
  high === low ? 0 : clamp01((value - low) / (high - low));

function numbers(data: TimeSeries | null, variable: string): number[] {
  return (data?.values[variable] ?? []).filter((v): v is number => v !== null);
}

// Reaching the "primary" threshold scores 0.5; twice that saturates at 1
export function historicalScore(profile: HazardProfile): number {
  if (profile.indicatorValue === null) return 0.25;
  return clamp01(profile.indicatorValue / (2 * profile.indicators.primaryThreshold));
}

// Built-in exposure of the exact point. Only flood hazards have one.
export function structuralScore(hazard: Hazard, features: StaticFeatures): number | null {
  if (hazard !== "river_flood" && hazard !== "flash_flood") return null;

  // 10 m below the surrounding ground scores 1, 10 m above scores 0
  const lowGround =
    features.relativeElevationM === null
      ? null
      : clamp01(0.5 - features.relativeElevationM / 20);
  if (hazard === "flash_flood") return lowGround;

  const exposure =
    features.floodExposureShare === null
      ? null
      : clamp01(features.floodExposureShare / (2 * LIMITS.exposurePrimary));
  if (exposure !== null && lowGround !== null) return 0.7 * exposure + 0.3 * lowGround;
  return exposure ?? lowGround;
}

function maxThreeDayRain(weather: TimeSeries | null): { total: number; index: number } | null {
  const rain: Series = weather?.values.precipitation_sum ?? [];
  let best: { total: number; index: number } | null = null;
  rollingSum(rain, 3).forEach((total, index) => {
    if (total !== null && (best === null || total > best.total)) best = { total, index };
  });
  return best;
}

function rainWarningLevel(profile: HazardProfile): number {
  return Math.max(profile.indicators.weather?.rain3dP99 ?? 0, LIMITS.minEventRainMm);
}

// How far the forecast window pushes towards the hazard's danger level
export function forecastScore(profile: HazardProfile, current: CurrentData): number {
  const { weather, flood } = current;
  switch (profile.hazard) {
    case "flash_flood": {
      const peak = maxThreeDayRain(weather);
      const warning = rainWarningLevel(profile);
      return peak ? ramp(peak.total, warning * 0.25, warning) : 0;
    }
    case "heat": {
      const tmax = numbers(weather, "temperature_2m_max");
      return tmax.length ? ramp(Math.max(...tmax), 35, LIMITS.severeHeatC) : 0;
    }
    case "cold_wave": {
      const tmin = numbers(weather, "temperature_2m_min");
      return tmin.length ? ramp(-Math.min(...tmin), -10, -LIMITS.severeColdC) : 0;
    }
    case "storm": {
      const gusts = numbers(weather, "wind_gusts_10m_max");
      return gusts.length ? ramp(Math.max(...gusts), 30, LIMITS.severeGustKmh) : 0;
    }
    case "drought": {
      // Volumetric soil moisture: 0.25 m3/m3 or wetter scores 0, 0.10 scores 1
      const soil = mean(weather?.values.soil_moisture_9_to_27cm ?? []);
      return soil === null ? 0 : ramp(-soil, -0.25, -0.1);
    }
    case "river_flood": {
      const river = profile.indicators.river;
      const discharge = numbers(flood, "river_discharge");
      if (!river || discharge.length === 0) return 0;
      return ramp(Math.max(...discharge), river.dischargeMedian, river.dischargeP99);
    }
  }
}

// +0 to +0.1 when projections show the hazard worsening by the 2040s
export function projectionAdjustment(hazard: Hazard, deltas: ProjectionDeltas | null): number {
  if (!deltas) return 0;
  const cap = CLIMATE.maxProjectionAdjustment;
  switch (hazard) {
    case "heat":
      return cap * clamp01((deltas.heatDaysDelta ?? 0) / 20);
    case "drought": {
      const drying = Math.max(-(deltas.precipChangePct ?? 0), -(deltas.soilMoistureChangePct ?? 0));
      return cap * clamp01(drying / 20);
    }
    case "flash_flood":
      return cap * clamp01((deltas.heavyRainChangePct ?? 0) / 20);
    default:
      return 0;
  }
}

export interface Components {
  structural: number | null;
  historical: number;
  forecast: number;
}

// Hazards without a structural signal move its weight to historical
export function hazardScore(components: Components, adjustment: number): number {
  const w = CLIMATE.scoreWeights;
  const base =
    components.structural === null
      ? (w.structural + w.historical) * components.historical
      : w.structural * components.structural + w.historical * components.historical;
  return clamp01(base + w.forecast * components.forecast + adjustment);
}

export function overallRisk(hazards: { relevance: Relevance; score: number }[]): number {
  let weighted = 0;
  let total = 0;
  for (const { relevance, score } of hazards) {
    const weight = CLIMATE.relevanceWeights[relevance];
    weighted += weight * score;
    total += weight;
  }
  return total === 0 ? 0 : weighted / total;
}

export function grade(risk: number): Grade {
  if (risk < 0.2) return "A";
  if (risk < 0.35) return "B";
  if (risk < 0.5) return "C";
  if (risk < 0.7) return "D";
  return "E";
}

export interface DataQuality {
  // Served from stale cache after an upstream failure
  staleServed: boolean;
  primaryMissing: boolean;
  secondaryMissing: boolean;
}

export function confidenceLevel(quality: DataQuality): ConfidenceLevel {
  if (quality.staleServed || quality.primaryMissing) return "low";
  if (quality.secondaryMissing) return "med";
  return "high";
}

interface Level {
  severity: Severity;
  test: (value: number, index: number) => boolean;
}

// Severity is the highest level any day reaches; the window spans every day
// that reaches the lowest level. Levels are ordered least to most severe.
function exceedance(
  hazard: Hazard,
  data: TimeSeries,
  variable: string,
  levels: Level[],
  confidence: (severity: Severity) => number,
): DetectedEvent | null {
  const values = data.values[variable] ?? [];
  let severity: Severity | null = null;
  let first = -1;
  let last = -1;
  values.forEach((value, i) => {
    if (value === null) return;
    levels.forEach((level, rank) => {
      if (!level.test(value, i)) return;
      if (rank === 0) {
        if (first === -1) first = i;
        last = i;
      }
      const current = levels.findIndex((l) => l.severity === severity);
      if (rank > current) severity = level.severity;
    });
  });
  const windowStart = data.time[first];
  const windowEnd = data.time[last];
  if (severity === null || !windowStart || !windowEnd) return null;
  return { hazard, severity, windowStart, windowEnd, confidence: confidence(severity) };
}

function flashFloodEvent(profile: HazardProfile, weather: TimeSeries): DetectedEvent | null {
  const peak = maxThreeDayRain(weather);
  const thresholds = profile.indicators.weather;
  if (!peak || !thresholds) return null;

  const floor = LIMITS.minEventRainMm;
  let severity: Severity | null = null;
  if (peak.total > Math.max(thresholds.rain3dP99, floor)) severity = "warning";
  else if (peak.total > Math.max(thresholds.rain3dP95, floor)) severity = "watch";
  const windowStart = weather.time[peak.index];
  const windowEnd = weather.time[peak.index + 2];
  if (severity === null || !windowStart || !windowEnd) return null;

  // `severe` needs ensemble agreement (README Call 7), which is not in the MVP
  const probability = mean(
    (weather.values.precipitation_probability_max ?? []).slice(peak.index, peak.index + 3),
  );
  const confidence = probability === null ? 0.6 : Math.max(0.1, probability / 100);
  return { hazard: "flash_flood", severity, windowStart, windowEnd, confidence };
}

function riverFloodEvent(profile: HazardProfile, flood: TimeSeries): DetectedEvent | null {
  const river = profile.indicators.river;
  if (!river) return null;
  const median = flood.values.river_discharge_median ?? [];
  const p75 = flood.values.river_discharge_p75 ?? [];
  const above = (list: Series, i: number, level: number) => (list[i] ?? -Infinity) > level;
  let p75AboveP99 = false;

  return exceedance(
    "river_flood",
    flood,
    "river_discharge",
    [
      { severity: "watch", test: (v) => v > river.dischargeP95 },
      {
        severity: "warning",
        test: (v, i) => {
          if (v <= river.dischargeP99) return false;
          if (above(p75, i, river.dischargeP99)) p75AboveP99 = true;
          return true;
        },
      },
      // Even the ensemble median is above the 99th percentile
      {
        severity: "severe",
        test: (v, i) => v > river.dischargeP99 && above(median, i, river.dischargeP99),
      },
    ],
    (severity) => {
      if (severity === "severe") return 0.9;
      if (severity === "warning") return p75AboveP99 ? 0.75 : 0.6;
      return 0.5;
    },
  );
}

// Events are separate from the score: raised when the forecast crosses a
// threshold. Drought is slow-onset and raises none.
export function detectEvents(
  profiles: Record<Hazard, HazardProfile>,
  current: CurrentData,
): DetectedEvent[] {
  const events: (DetectedEvent | null)[] = [];
  const { weather, flood } = current;

  if (weather) {
    const thresholds = profiles.heat.indicators.weather;
    const fixed = (severity: Severity) => (severity === "watch" ? 0.6 : 0.7);
    events.push(
      flashFloodEvent(profiles.flash_flood, weather),
      exceedance(
        "heat",
        weather,
        "temperature_2m_max",
        [
          {
            severity: "watch",
            test: (v) =>
              v >= LIMITS.severeHeatC ||
              (v >= LIMITS.heatC && v > (thresholds?.tmaxP95 ?? 0)),
          },
          {
            severity: "warning",
            test: (v) =>
              v >= LIMITS.severeHeatC ||
              (v >= LIMITS.heatC && v > (thresholds?.tmaxP99 ?? Infinity)),
          },
        ],
        fixed,
      ),
      exceedance(
        "storm",
        weather,
        "wind_gusts_10m_max",
        [
          { severity: "watch", test: (v) => v >= LIMITS.gustKmh },
          { severity: "warning", test: (v) => v >= LIMITS.severeGustKmh },
        ],
        fixed,
      ),
      exceedance(
        "cold_wave",
        weather,
        "temperature_2m_min",
        [
          { severity: "watch", test: (v) => v < LIMITS.coldC },
          { severity: "warning", test: (v) => v < LIMITS.severeColdC },
        ],
        fixed,
      ),
    );
  }
  if (flood) events.push(riverFloodEvent(profiles.river_flood, flood));

  return events.filter((event): event is DetectedEvent => event !== null);
}
