import { addDays } from "../profile.service.js";
import type { Hazard, TimeSeries } from "../types.js";
import type { BaseTripwire } from "./rules.js";
import { crosses, type MonitorLevel, type Tripwire } from "./types.js";

// Labelling of disaster events against observed data. Pure: the job in
// verifyJob.ts does the fetching and the writing.

// Stored in `disaster_events.observed_values`, next to the forecast numbers
export interface ObservedValues {
  variable: string;
  threshold: number;
  direction: Tripwire["direction"];
  // Most extreme observed value in the window, and the day it fell on
  peak: number | null;
  peakDate: string | null;
  crossed: boolean;
}

export interface Label {
  status: "hit" | "false_alarm";
  observed: ObservedValues;
}

function daysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

// Compares what was observed in an event's window with the tripwire the
// forecast crossed. Null means the observed data is not complete yet and
// nothing crossed so far, so the event stays pending.
export function labelEvent(
  event: { windowStart: string; windowEnd: string },
  tripwire: Tripwire,
  observed: TimeSeries | null,
): Label | null {
  const series = observed?.values[tripwire.variable];
  if (!observed || !series) return null;
  const byDay = new Map(observed.time.map((day, i) => [day, series[i] ?? null]));

  let peak: number | null = null;
  let peakDate: string | null = null;
  let complete = true;
  for (const day of daysBetween(event.windowStart, event.windowEnd)) {
    const value = byDay.get(day) ?? null;
    if (value === null) {
      complete = false;
      continue;
    }
    const more = peak === null || (tripwire.direction === "above" ? value > peak : value < peak);
    if (more) {
      peak = value;
      peakDate = day;
    }
  }

  const crossed = peak !== null && crosses(peak, tripwire);
  // A crossing settles it even with days missing; a false alarm needs them all
  if (!crossed && !complete) return null;
  return {
    status: crossed ? "hit" : "false_alarm",
    observed: { ...tripwire, peak, peakDate, crossed },
  };
}

export interface MissedRun {
  hazard: Hazard;
  level: MonitorLevel;
  windowStart: string;
  windowEnd: string;
  observed: ObservedValues;
}

interface Run {
  start: string;
  end: string;
  peak: number;
  peakDate: string;
}

export interface MissedInput {
  tripwires: Partial<Record<Hazard, BaseTripwire>>;
  weather: TimeSeries | null;
  river: TimeSeries | null;
  // Days scanned, inclusive
  from: string;
  to: string;
  // Events already recorded for the cell, of any status
  events: { hazard: string; windowStart: string; windowEnd: string }[];
  toleranceDays: number;
}

// Runs of consecutive days on which an observed value crossed a hazard's
// tripwire, where no recorded event comes within `toleranceDays` of the run.
// A `missed` event recorded earlier counts as recorded, so scanning the same
// days twice adds nothing.
export function findMissed(input: MissedInput): MissedRun[] {
  const missed: MissedRun[] = [];

  for (const [hazard, base] of Object.entries(input.tripwires) as [Hazard, BaseTripwire][]) {
    const { tripwire } = base;
    const data = tripwire.variable === "river_discharge" ? input.river : input.weather;
    const series = data?.values[tripwire.variable];
    if (!data || !series) continue;
    const byDay = new Map(data.time.map((day, i) => [day, series[i] ?? null]));

    const runs: Run[] = [];
    let open: Run | null = null;
    for (const day of daysBetween(input.from, input.to)) {
      const value = byDay.get(day) ?? null;
      if (value === null || !crosses(value, tripwire)) {
        open = null;
        continue;
      }
      if (!open) {
        open = { start: day, end: day, peak: value, peakDate: day };
        runs.push(open);
        continue;
      }
      open.end = day;
      if (tripwire.direction === "above" ? value > open.peak : value < open.peak) {
        open.peak = value;
        open.peakDate = day;
      }
    }

    for (const { start, end, peak, peakDate } of runs) {
      const forecast = input.events.some(
        (event) =>
          event.hazard === hazard &&
          event.windowStart <= addDays(end, input.toleranceDays) &&
          event.windowEnd >= addDays(start, -input.toleranceDays),
      );
      if (forecast) continue;
      missed.push({
        hazard,
        level: base.level,
        windowStart: start,
        windowEnd: end,
        observed: { ...tripwire, peak, peakDate, crossed: true },
      });
    }
  }
  return missed;
}
