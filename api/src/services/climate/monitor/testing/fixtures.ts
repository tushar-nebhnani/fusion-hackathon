import { CLIMATE } from "../../../../config/climate.js";
import type { ClimateInspector, DetailedProfile, ProfileOptions } from "../../profile.service.js";
import { addDays } from "../../profile.service.js";
import { climateProfileSchema, type ClimateProfile } from "../../schema.js";
import { HAZARDS, type Hazard, type LatLon, type RiverIndicators, type TimeSeries } from "../../types.js";
import type { AlertEvent, AlertSink, RunLogger, WatchedLocation } from "../ports.js";
import type { CellState, MonitorSettings, Snapshot } from "../types.js";

// Shared by the monitor's tests. 06:00 UTC is 11:30 IST on the same day.
export const START = new Date("2026-10-09T06:00:00Z");
export const TODAY = "2026-10-09";
export const SETTINGS: MonitorSettings = CLIMATE.monitor;
export const HOUR_MS = 3_600_000;

export const RIVER: RiverIndicators = { dischargeMedian: 500, dischargeP95: 800, dischargeP99: 1000 };

export const CHENNAI: WatchedLocation = {
  locationId: "L1",
  businessId: "SME-0142",
  lat: 13.0827,
  lon: 80.2707,
};
// A second business in the same 0.1 degree cell
export const CHENNAI_NEIGHBOUR: WatchedLocation = {
  locationId: "L2",
  businessId: "SME-0143",
  lat: 13.085,
  lon: 80.272,
};
export const PUNE: WatchedLocation = {
  locationId: "L3",
  businessId: "SME-0201",
  lat: 18.5204,
  lon: 73.8567,
};
export const CHENNAI_CELL = "0.1:13.1:80.3";
export const PUNE_CELL = "0.1:18.5:73.9";

const week = (from: string) => Array.from({ length: 7 }, (_, i) => addDays(from, i));

export interface WeatherScript {
  rain?: number[];
  // Null leaves the variable out, as for a dormant hazard
  probability?: number[] | null;
  tmax?: number[];
  gust?: number[] | null;
  tmin?: number[];
}

// A 7-day forecast from `from`. Days not given are calm.
export function weatherOf(script: WeatherScript = {}, from = TODAY): TimeSeries {
  const time = week(from);
  const fill = (list: number[] | undefined, calm: number) => time.map((_, i) => list?.[i] ?? calm);
  return {
    time,
    values: {
      precipitation_sum: fill(script.rain, 0),
      temperature_2m_max: fill(script.tmax, 30),
      ...(script.probability === null
        ? {}
        : { precipitation_probability_max: fill(script.probability, 80) }),
      ...(script.gust === null ? {} : { wind_gusts_10m_max: fill(script.gust, 20) }),
      ...(script.tmin ? { temperature_2m_min: fill(script.tmin, 15) } : {}),
    },
  };
}

export function floodOf(discharge: number[], from = TODAY): TimeSeries {
  const time = week(from);
  return { time, values: { river_discharge: time.map((_, i) => discharge[i] ?? 500) } };
}

export interface ProfileScript {
  dormant?: Hazard[];
  // Dormant hazards the unit promoted because their tripwire tripped
  promoted?: Hazard[];
  events?: ClimateProfile["active_events"];
  forecastScores?: Partial<Record<Hazard, number>>;
}

// A profile that passes the climate unit's own output schema
export function profileOf(script: ProfileScript = {}): ClimateProfile {
  return climateProfileSchema.parse({
    location: {
      lat: CHENNAI.lat,
      lon: CHENNAI.lon,
      cells: {
        historical: CHENNAI_CELL,
        climate: CHENNAI_CELL,
        flood: "0.05:13.10:80.25",
        forecast: CHENNAI_CELL,
      },
    },
    overall_climate_risk: 0.3,
    grade: "B",
    confidence: "med",
    hazards: HAZARDS.map((hazard) => {
      const promoted = script.promoted?.includes(hazard) ?? false;
      return {
        hazard,
        relevance: promoted ? "secondary" : script.dormant?.includes(hazard) ? "dormant" : "primary",
        relevance_method: "static",
        ...(promoted ? { tripwire_promoted: true } : {}),
        score: 0.3,
        components: { historical: 0.4, forecast: script.forecastScores?.[hazard] ?? 0.1 },
        reason: "fixture",
      };
    }),
    active_events: script.events ?? [],
    data_freshness: { forecast_issued_at: null, history_until: null },
    cache: "partial_hit",
    warnings: [],
  });
}

export interface DetailScript extends ProfileScript {
  weather?: WeatherScript | null;
  // Daily discharge; absent means the river forecast was skipped or failed
  flood?: number[] | null;
  river?: RiverIndicators | null;
  from?: string;
}

export function detailedOf(script: DetailScript = {}): DetailedProfile {
  const from = script.from ?? TODAY;
  return {
    profile: profileOf(script),
    forecast: {
      window: { start: from, end: addDays(from, 6) },
      weather: script.weather === null ? null : weatherOf(script.weather, from),
      flood: script.flood ? floodOf(script.flood, from) : null,
      weatherHistory: null,
      riverHistory: script.river === undefined ? RIVER : script.river,
    },
  };
}

export function snapshotOf(levels: Partial<Snapshot["levels"]> = {}, at = START): Snapshot {
  return {
    at: at.toISOString(),
    levels: {
      river_flood: "NORMAL",
      flash_flood: "NORMAL",
      heat: "NORMAL",
      drought: "NORMAL",
      storm: "NORMAL",
      cold_wave: "NORMAL",
      ...levels,
    },
    values: {
      rainMaxMm: 0,
      rainProbabilityPct: 80,
      tmaxC: 30,
      gustKmh: 20,
      dischargeMaxM3s: null,
      riverHighM3s: null,
      forecastScores: {
        river_flood: 0.1,
        flash_flood: 0.1,
        heat: 0.1,
        drought: 0.1,
        storm: 0.1,
        cold_wave: 0.1,
      },
    },
  };
}

export function cellOf(overrides: Partial<CellState> = {}): CellState {
  return {
    cellId: CHENNAI_CELL,
    lat: CHENNAI.lat,
    lon: CHENNAI.lon,
    active: true,
    level: "NORMAL",
    calmRuns: 0,
    nextCheckAt: START,
    lastCheckedAt: null,
    lastSnapshot: null,
    lastAgentReviewAt: null,
    createdAt: START,
    ...overrides,
  };
}

export interface ClimateCall {
  point: LatLon;
  requesterId: string | null | undefined;
  options: ProfileOptions | undefined;
}

// Stands in for the climate unit's entry function. `script` is what every
// cell sees; `respond` can answer one call differently (or never).
export function stubClimate(script: DetailScript = {}) {
  const calls: ClimateCall[] = [];
  const state: {
    script: DetailScript;
    respond: ((point: LatLon) => Promise<DetailedProfile> | undefined) | null;
  } = { script, respond: null };
  const climate: ClimateInspector = {
    getProfileWithForecast(point, requesterId, options) {
      calls.push({ point, requesterId, options });
      return state.respond?.(point) ?? Promise.resolve(detailedOf(state.script));
    },
  };
  return { climate, calls, state };
}

export function recordingSink() {
  const events: AlertEvent[] = [];
  const state: { answer: boolean | "throw" } = { answer: true };
  const sink: AlertSink = {
    enqueue(event) {
      events.push(event);
      if (state.answer === "throw") return Promise.reject(new Error("alert system is down"));
      return Promise.resolve(state.answer);
    },
  };
  return { sink, events, state };
}

export function memoryLogger() {
  const lines: { level: "info" | "warn" | "error"; message: string }[] = [];
  const logger: RunLogger = {
    info: (message) => void lines.push({ level: "info", message }),
    warn: (message) => void lines.push({ level: "warn", message }),
    error: (message) => void lines.push({ level: "error", message }),
  };
  const of = (level: "info" | "warn" | "error") =>
    lines.filter((line) => line.level === level).map((line) => line.message);
  return { logger, lines, of };
}

export const never = <T>() => new Promise<T>(() => undefined);
