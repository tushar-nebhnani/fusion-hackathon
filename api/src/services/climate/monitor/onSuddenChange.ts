import type { AlertEvent, AlertSink, RunLogger, WatchedLocation } from "./ports.js";
import type { Finding, MonitorLevel, NewDisasterEvent, SnapshotValues } from "./types.js";

const SEVERITY: Record<MonitorLevel, AlertEvent["severity"] | null> = {
  NORMAL: null,
  WATCH: "WATCH",
  WARNING: "WARNING",
  SEVERE: "CRITICAL",
};

// The alert system's limit on `evidence`
const MAX_EVIDENCE = 500;

export interface SuddenChangeInput {
  cellId: string;
  locations: WatchedLocation[];
  sudden: Finding[];
  // Key forecast values of the check, stored with each disaster event
  values: SnapshotValues;
  runId: string;
}

export interface SuddenChangeOutcome {
  // One per sudden finding, for the caller to store with the cell's new state
  events: NewDisasterEvent[];
  alerts: number;
  accepted: number;
}

// What happens when a hazard rises: every business in the cell is told, and
// the forecast is recorded so it can be checked against what really happened.
// Alerts are not de-duplicated here; the alert system owns cooldowns. A sink
// that refuses or fails is logged and never stops the check.
export async function onSuddenChange(
  deps: { sink: AlertSink; logger: RunLogger },
  input: SuddenChangeInput,
): Promise<SuddenChangeOutcome> {
  const alerts: AlertEvent[] = [];
  const events: NewDisasterEvent[] = [];

  for (const finding of input.sudden) {
    const severity = SEVERITY[finding.level];
    if (!severity) continue;
    const evidence = finding.evidence.slice(0, MAX_EVIDENCE);
    for (const location of input.locations) {
      alerts.push({
        businessId: location.businessId,
        hazard: finding.hazard,
        severity,
        windowStart: finding.windowStart,
        windowEnd: finding.windowEnd,
        evidence,
        sourceRunId: input.runId,
      });
    }
    events.push({
      cellId: input.cellId,
      hazard: finding.hazard,
      level: finding.level,
      windowStart: finding.windowStart,
      windowEnd: finding.windowEnd,
      forecastValues: {
        ...finding.values,
        tripwire: finding.tripwire,
        source: finding.source,
        dormant: finding.dormant,
        cell: input.values,
      },
      evidence,
      sourceRunId: input.runId,
    });
  }

  const results = await Promise.all(
    alerts.map(async (alert) => {
      try {
        return await deps.sink.enqueue(alert);
      } catch (error) {
        deps.logger.error(
          `alert sink threw for ${alert.businessId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return false;
      }
    }),
  );
  const accepted = results.filter(Boolean).length;
  if (accepted < alerts.length) {
    deps.logger.warn(
      `${alerts.length - accepted} of ${alerts.length} alerts for ${input.cellId} were not accepted by the alert sink`,
    );
  }
  return { events, alerts: alerts.length, accepted };
}
