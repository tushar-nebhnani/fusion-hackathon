import { withTimeout } from "../../alerts/withTimeout.js";
import type { ClimateInspector } from "../profile.service.js";
import type { AgentReviewer } from "./agentReview.js";
import { advance, nextCheckAt } from "./cadence.js";
import { onSuddenChange } from "./onSuddenChange.js";
import type { AlertSink, Clock, RunLogger, WatchedLocation } from "./ports.js";
import type { MonitorRepo } from "./repo.js";
import { evaluateRules, snapshotOf } from "./rules.js";
import type { CellState, Finding, MonitorLevel, MonitorSettings } from "./types.js";

// Recorded as `request_log.requester_id`, so monitor checks can be told apart
export const MONITOR_REQUESTER = "climate-monitor";

export interface CheckDeps {
  climate: ClimateInspector;
  sink: AlertSink;
  logger: RunLogger;
  clock: Clock;
  repo: MonitorRepo;
  review: AgentReviewer;
  settings: MonitorSettings;
  instanceId: string;
}

export interface CheckOutcome {
  cellId: string;
  from: MonitorLevel;
  to: MonitorLevel;
  calmRuns: number;
  nextCheckAt: Date;
  sudden: Finding[];
  alerts: number;
  accepted: number;
}

// One check of one claimed cell: fresh forecast through the climate unit's
// normal pipeline, rules, optional agent, then the decision. Throws when the
// cell could not be checked; the caller keeps its state and tries again on
// the next tick.
export async function checkCell(
  deps: CheckDeps,
  cell: CellState,
  locations: WatchedLocation[],
  runId: string,
): Promise<CheckOutcome> {
  const { settings } = deps;
  const detailed = await withTimeout(
    deps.climate.getProfileWithForecast({ lat: cell.lat, lon: cell.lon }, MONITOR_REQUESTER, {
      forceFreshForecast: true,
    }),
    cell.lastCheckedAt ? settings.entryTimeoutMs : settings.firstCheckTimeoutMs,
    `climate profile of ${cell.cellId}`,
  );
  // Without a weather forecast there is nothing to compare; calling that a
  // calm run would step the cell down on no evidence
  if (!detailed.forecast.weather) throw new Error("the weather forecast is unavailable");

  const now = deps.clock.now();
  const rules = evaluateRules({
    now,
    profile: detailed.profile,
    forecast: detailed.forecast,
    previous: cell.lastSnapshot,
    settings,
  });
  const reviewed = await deps.review(cell, detailed, rules, now);
  const result = reviewed.result;

  const sudden = result.sudden.length > 0;
  const cadence = advance({ level: cell.level, calmRuns: cell.calmRuns }, result.level, sudden, settings);
  const dueAt = nextCheckAt(now, cadence.level, settings);

  // Alerts go out before the state is saved: if the save fails the change is
  // found again next tick and the alert system drops the repeat. The other
  // order could lose an alert for good.
  const change = sudden
    ? await onSuddenChange(deps, {
        cellId: cell.cellId,
        locations,
        sudden: result.sudden,
        values: result.values,
        runId,
      })
    : { events: [], alerts: 0, accepted: 0 };

  await deps.repo.saveCheck(
    cell.cellId,
    deps.instanceId,
    {
      level: cadence.level,
      calmRuns: cadence.calmRuns,
      nextCheckAt: dueAt,
      lastCheckedAt: now,
      lastSnapshot: snapshotOf(result, now, reviewed.agent),
      lastAgentReviewAt: reviewed.lastAgentReviewAt,
    },
    change.events,
  );

  return {
    cellId: cell.cellId,
    from: cell.level,
    to: cadence.level,
    calmRuns: cadence.calmRuns,
    nextCheckAt: dueAt,
    sudden: result.sudden,
    alerts: change.alerts,
    accepted: change.accepted,
  };
}
