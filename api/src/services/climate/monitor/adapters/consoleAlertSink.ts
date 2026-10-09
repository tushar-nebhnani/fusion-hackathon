import type { AlertEvent, AlertSink } from "../ports.js";

// Prints each alert instead of queueing it. Used by the simulator, and by the
// monitor when MONITOR_ALERT_SINK=console.
export function createConsoleAlertSink(
  print: (line: string) => void = console.log,
): AlertSink & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    enqueue(event) {
      events.push(event);
      print(
        `ALERT ${event.severity} ${event.hazard} -> ${event.businessId} ` +
          `(${event.windowStart} to ${event.windowEnd}): ${event.evidence} [${event.sourceRunId}]`,
      );
      return Promise.resolve(true);
    },
  };
}
