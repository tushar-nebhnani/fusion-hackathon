import { LEVELS, LEVEL_RANK, type MonitorLevel, type MonitorSettings } from "./types.js";

const HOUR_MS = 3_600_000;

export interface Cadence {
  level: MonitorLevel;
  calmRuns: number;
}

type CadenceSettings = Pick<MonitorSettings, "intervalHours" | "calmRunsToStepDown">;

export const intervalMs = (level: MonitorLevel, settings: CadenceSettings): number =>
  settings.intervalHours[level] * HOUR_MS;

export const nextCheckAt = (now: Date, level: MonitorLevel, settings: CadenceSettings): Date =>
  new Date(now.getTime() + intervalMs(level, settings));

const stepDown = (level: MonitorLevel): MonitorLevel =>
  LEVELS[Math.max(0, LEVEL_RANK[level] - 1)] ?? "NORMAL";

// A cell's level after one check. `observed` is the highest hazard level the
// check found; `sudden` says whether any hazard rose.
//  - Higher than the cell's level: jump straight to it.
//  - A calm run is one with no rise and nothing at the cell's level any more.
//    After enough of them in a row the cell steps down one level, never more.
//  - Any other run resets the count.
export function advance(
  current: Cadence,
  observed: MonitorLevel,
  sudden: boolean,
  settings: CadenceSettings,
): Cadence {
  if (LEVEL_RANK[observed] > LEVEL_RANK[current.level]) return { level: observed, calmRuns: 0 };
  if (sudden || observed === current.level) return { level: current.level, calmRuns: 0 };

  const calmRuns = current.calmRuns + 1;
  if (calmRuns >= settings.calmRunsToStepDown) {
    return { level: stepDown(current.level), calmRuns: 0 };
  }
  return { level: current.level, calmRuns };
}
