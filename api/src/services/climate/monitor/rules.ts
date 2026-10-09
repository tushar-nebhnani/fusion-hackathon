import { LIMITS } from "../hazards.js";
import { addDays, istDate, type ForecastDetail } from "../profile.service.js";
import type { ClimateProfile } from "../schema.js";
import { HAZARDS, type Hazard, type Severity, type TimeSeries } from "../types.js";
import {
  LEVEL_RANK,
  maxLevel,
  type AgentRaises,
  type Finding,
  type MonitorLevel,
  type MonitorSettings,
  type RuleResult,
  type Snapshot,
  type SnapshotValues,
  type Tripwire,
} from "./types.js";

// The monitor's primary rules. Pure: no I/O and no clock reads, so the same
// input always gives the same result.
//
// They build on the climate unit instead of repeating it. Heat, storm and
// cold use its LIMITS; cold wave and the river's watch and severe levels come
// from its own active events; the river's historical high is its stored 99th
// percentile; a hazard is dormant when its profile says so. Only the IMD rain
// classes are new, and they live in CLIMATE.monitor.

export type RuleSettings = Pick<MonitorSettings, "rain" | "riverRainWithinHours" | "dormantTripLevel">;

export interface RuleInput {
  now: Date;
  profile: ClimateProfile;
  forecast: ForecastDetail;
  // Null on a cell's first check: every hazard then counts as NORMAL before
  previous: Snapshot | null;
  settings: RuleSettings;
}

const EVENT_LEVEL: Record<Severity, MonitorLevel> = {
  watch: "WATCH",
  warning: "WARNING",
  severe: "SEVERE",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-12" -> "12 Oct"
export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ""}`.trim();
}

const num = (value: number) => String(Number(value.toFixed(1)));

interface Peak {
  value: number;
  index: number;
  date: string;
  // First and last day that counted
  first: string;
  last: string;
}

// The most extreme value among the days that pass `counts`, and their span
function peak(
  data: TimeSeries,
  variable: string,
  counts: (value: number, index: number) => boolean,
  lowest = false,
): Peak | null {
  let best: Peak | null = null;
  (data.values[variable] ?? []).forEach((value, index) => {
    const date = data.time[index];
    if (value === null || !date || !counts(value, index)) return;
    if (best === null) {
      best = { value, index, date, first: date, last: date };
      return;
    }
    const more = lowest ? value < best.value : value > best.value;
    best = more
      ? { value, index, date, first: best.first, last: date }
      : { ...best, last: date };
  });
  return best;
}

const everyDay = () => true;

// Rain only counts when it is likely enough. Where no probability is fetched
// (the hazard is dormant, so only the tripwire variables are), the amount
// alone decides.
function heavyRain(weather: TimeSeries, settings: RuleSettings) {
  const probability = weather.values.precipitation_probability_max;
  return (mm: number, index: number) => {
    const chance = probability?.[index] ?? null;
    return mm >= settings.rain.heavyMm && (chance === null || chance >= settings.rain.minProbabilityPct);
  };
}

function build(
  settings: RuleSettings,
  dormant: boolean,
  finding: Omit<Finding, "dormant">,
): Finding {
  if (!dormant) return { ...finding, dormant };
  return {
    ...finding,
    dormant,
    level: maxLevel(finding.level, settings.dormantTripLevel),
    evidence: `${finding.evidence}; this hazard is normally dormant here`,
  };
}

function rainFinding(weather: TimeSeries, dormant: boolean, settings: RuleSettings): Finding | null {
  const hit = peak(weather, "precipitation_sum", heavyRain(weather, settings));
  if (!hit) return null;
  const { rain } = settings;
  const [level, threshold]: [MonitorLevel, number] =
    hit.value >= rain.extremelyHeavyMm
      ? ["SEVERE", rain.extremelyHeavyMm]
      : hit.value >= rain.veryHeavyMm
        ? ["WARNING", rain.veryHeavyMm]
        : ["WATCH", rain.heavyMm];
  const chance = weather.values.precipitation_probability_max?.[hit.index] ?? null;
  return build(settings, dormant, {
    hazard: "flash_flood",
    level,
    windowStart: hit.first,
    windowEnd: hit.last,
    evidence:
      `${num(hit.value)} mm rain forecast on ${shortDate(hit.date)}, ` +
      (chance === null ? "probability not forecast" : `${num(chance)}% probability`),
    source: "rules",
    tripwire: { variable: "precipitation_sum", threshold, direction: "above" },
    values: { rain_mm: hit.value, rain_probability_pct: chance, date: hit.date },
  });
}

// A value at or above `watch` is a WATCH, at or above `warning` a WARNING
function exceedance(
  weather: TimeSeries,
  spec: {
    hazard: Hazard;
    variable: string;
    watch: number;
    warning: number;
    describe: (value: string, date: string) => string;
    valueKey: string;
  },
  dormant: boolean,
  settings: RuleSettings,
): Finding | null {
  const hit = peak(weather, spec.variable, (value) => value >= spec.watch);
  if (!hit) return null;
  const warning = hit.value >= spec.warning;
  return build(settings, dormant, {
    hazard: spec.hazard,
    level: warning ? "WARNING" : "WATCH",
    windowStart: hit.first,
    windowEnd: hit.last,
    evidence: spec.describe(num(hit.value), shortDate(hit.date)),
    source: "rules",
    tripwire: {
      variable: spec.variable,
      threshold: warning ? spec.warning : spec.watch,
      direction: "above",
    },
    values: { [spec.valueKey]: hit.value, date: hit.date },
  });
}

// The monitor has no cold thresholds of its own: the unit's event decides
function coldFinding(
  profile: ClimateProfile,
  weather: TimeSeries,
  dormant: boolean,
  settings: RuleSettings,
): Finding | null {
  const event = profile.active_events.find((e) => e.hazard === "cold_wave");
  if (!event) return null;
  const coldest = peak(weather, "temperature_2m_min", everyDay, true);
  return build(settings, dormant, {
    hazard: "cold_wave",
    level: EVENT_LEVEL[event.severity],
    windowStart: event.window_start,
    windowEnd: event.window_end,
    evidence: coldest
      ? `${num(coldest.value)} °C min temperature forecast on ${shortDate(coldest.date)}`
      : `Cold wave ${event.severity} raised by the climate unit`,
    source: "climate_event",
    tripwire: {
      variable: "temperature_2m_min",
      threshold: event.severity === "watch" ? LIMITS.coldC : LIMITS.severeColdC,
      direction: "below",
    },
    values: { tmin_c: coldest?.value ?? null, date: coldest?.date ?? null },
  });
}

function riverFinding(input: RuleInput, dormant: boolean): Finding | null {
  const { profile, forecast, settings } = input;
  const { flood, weather } = forecast;
  const river = forecast.riverHistory;
  if (!flood) return null;

  const top = peak(flood, "river_discharge", everyDay);
  const values = {
    discharge_m3s: top?.value ?? null,
    date: top?.date ?? null,
    historical_high_m3s: river?.dischargeP99 ?? null,
  };
  let found: Omit<Finding, "dormant"> | null = null;

  if (river) {
    const over = peak(flood, "river_discharge", (value) => value > river.dischargeP99);
    if (over) {
      // Heavy rain soon on top of a river already over its high
      const days = Math.ceil(settings.riverRainWithinHours / 24);
      const until = addDays(istDate(input.now), days - 1);
      const heavy = weather ? heavyRain(weather, settings) : null;
      const soon =
        weather && heavy
          ? peak(
              weather,
              "precipitation_sum",
              (mm, index) => (weather.time[index] ?? "") <= until && heavy(mm, index),
            )
          : null;
      found = {
        hazard: "river_flood",
        level: soon ? "SEVERE" : "WARNING",
        windowStart: over.first,
        windowEnd: over.last,
        evidence:
          `River discharge ${num(over.value)} m³/s forecast on ${shortDate(over.date)}, ` +
          `above the historical high of ${num(river.dischargeP99)} m³/s` +
          (soon
            ? `; ${num(soon.value)} mm rain forecast within ${settings.riverRainWithinHours} h`
            : ""),
        source: "rules",
        tripwire: { variable: "river_discharge", threshold: river.dischargeP99, direction: "above" },
        values: { ...values, rain_mm_soon: soon?.value ?? null },
      };
    }
  }

  // The unit's own event adds the watch level (95th percentile) and the
  // ensemble-backed severe level
  const event = profile.active_events.find((e) => e.hazard === "river_flood");
  if (event && LEVEL_RANK[EVENT_LEVEL[event.severity]] > LEVEL_RANK[found?.level ?? "NORMAL"]) {
    const watch = event.severity === "watch";
    const threshold = river ? (watch ? river.dischargeP95 : river.dischargeP99) : null;
    found = {
      hazard: "river_flood",
      level: EVENT_LEVEL[event.severity],
      windowStart: event.window_start,
      windowEnd: event.window_end,
      evidence: top
        ? `River discharge ${num(top.value)} m³/s forecast on ${shortDate(top.date)}, ` +
          `above the cell's ${watch ? "95th" : "99th"} percentile` +
          (threshold === null ? "" : ` (${num(threshold)} m³/s)`)
        : `River flood ${event.severity} raised by the climate unit`,
      source: "climate_event",
      tripwire:
        threshold === null ? null : { variable: "river_discharge", threshold, direction: "above" },
      values,
    };
  }
  return found ? build(settings, dormant, found) : null;
}

function snapshotValues(profile: ClimateProfile, forecast: ForecastDetail): SnapshotValues {
  const { weather, flood } = forecast;
  const wettest = weather ? peak(weather, "precipitation_sum", everyDay) : null;
  const top = (data: TimeSeries | null, variable: string) =>
    data ? (peak(data, variable, everyDay)?.value ?? null) : null;
  return {
    rainMaxMm: wettest?.value ?? null,
    rainProbabilityPct:
      wettest && weather
        ? (weather.values.precipitation_probability_max?.[wettest.index] ?? null)
        : null,
    tmaxC: top(weather, "temperature_2m_max"),
    gustKmh: top(weather, "wind_gusts_10m_max"),
    dischargeMaxM3s: top(flood, "river_discharge"),
    riverHighM3s: forecast.riverHistory?.dischargeP99 ?? null,
    forecastScores: Object.fromEntries(
      HAZARDS.map((hazard) => [
        hazard,
        profile.hazards.find((h) => h.hazard === hazard)?.components.forecast ?? 0,
      ]),
    ) as Record<Hazard, number>,
  };
}

// Findings whose level is higher than in the last snapshot. A dormant hazard
// whose tripwire trips is one of them: it was NORMAL before.
export function suddenChanges(findings: Finding[], previous: Snapshot | null): Finding[] {
  return findings.filter(
    (finding) =>
      LEVEL_RANK[finding.level] > LEVEL_RANK[previous?.levels[finding.hazard] ?? "NORMAL"],
  );
}

export const highest = (levels: Record<Hazard, MonitorLevel>): MonitorLevel =>
  HAZARDS.reduce<MonitorLevel>((top, hazard) => maxLevel(top, levels[hazard]), "NORMAL");

export function evaluateRules(input: RuleInput): RuleResult {
  const { profile, forecast, previous, settings } = input;
  const weather = forecast.weather;
  const dormant = (hazard: Hazard) => {
    const entry = profile.hazards.find((h) => h.hazard === hazard);
    return entry?.relevance === "dormant" || entry?.tripwire_promoted === true;
  };

  const findings: Finding[] = [];
  const add = (finding: Finding | null) => {
    if (finding) findings.push(finding);
  };

  if (weather) {
    add(rainFinding(weather, dormant("flash_flood"), settings));
    add(
      exceedance(
        weather,
        {
          hazard: "heat",
          variable: "temperature_2m_max",
          watch: LIMITS.heatC,
          warning: LIMITS.severeHeatC,
          describe: (value, date) => `${value} °C max temperature forecast on ${date}`,
          valueKey: "tmax_c",
        },
        dormant("heat"),
        settings,
      ),
    );
    add(
      exceedance(
        weather,
        {
          hazard: "storm",
          variable: "wind_gusts_10m_max",
          watch: LIMITS.gustKmh,
          warning: LIMITS.severeGustKmh,
          describe: (value, date) => `${value} km/h wind gusts forecast on ${date}`,
          valueKey: "gust_kmh",
        },
        dormant("storm"),
        settings,
      ),
    );
    add(coldFinding(profile, weather, dormant("cold_wave"), settings));
  }
  add(riverFinding(input, dormant("river_flood")));

  // A hazard that could not be looked at keeps its last level: a missing
  // forecast is not evidence that the danger has passed. A dormant river has
  // no forecast by design, so it is NORMAL, not unknown.
  const seen = (hazard: Hazard) => {
    if (hazard === "drought") return true;
    if (hazard === "river_flood") return forecast.flood !== null || dormant(hazard);
    return weather !== null;
  };
  const levels = Object.fromEntries(
    HAZARDS.map((hazard) => [
      hazard,
      findings.find((f) => f.hazard === hazard)?.level ??
        (seen(hazard) ? "NORMAL" : (previous?.levels[hazard] ?? "NORMAL")),
    ]),
  ) as Record<Hazard, MonitorLevel>;

  return {
    levels,
    level: highest(levels),
    findings,
    sudden: suddenChanges(findings, previous),
    values: snapshotValues(profile, forecast),
  };
}

export function snapshotOf(result: RuleResult, now: Date, agent?: AgentRaises): Snapshot {
  return {
    at: now.toISOString(),
    levels: result.levels,
    values: result.values,
    ...(agent ? { agent } : {}),
  };
}

export interface BaseTripwire {
  tripwire: Tripwire;
  level: MonitorLevel;
}

// The lowest threshold at which each hazard becomes a finding. Used to label
// an event that has no tripwire of its own and to find extremes nobody
// forecast. Drought has none.
export function baseTripwires(
  river: { dischargeP99: number } | null,
  settings: Pick<MonitorSettings, "rain">,
): Partial<Record<Hazard, BaseTripwire>> {
  const above = (variable: string, threshold: number): Tripwire => ({
    variable,
    threshold,
    direction: "above",
  });
  return {
    flash_flood: { tripwire: above("precipitation_sum", settings.rain.heavyMm), level: "WATCH" },
    heat: { tripwire: above("temperature_2m_max", LIMITS.heatC), level: "WATCH" },
    storm: { tripwire: above("wind_gusts_10m_max", LIMITS.gustKmh), level: "WATCH" },
    cold_wave: {
      tripwire: { variable: "temperature_2m_min", threshold: LIMITS.coldC, direction: "below" },
      level: "WATCH",
    },
    ...(river
      ? { river_flood: { tripwire: above("river_discharge", river.dischargeP99), level: "WARNING" } }
      : {}),
  };
}
