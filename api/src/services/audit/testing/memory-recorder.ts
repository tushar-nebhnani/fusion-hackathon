import type { AuditEvent, AuditRecorder } from "../recorder.js";

// Keeps the events in a list, for route tests that are not about the database
export function memoryAuditRecorder(): AuditRecorder & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    record: (event) => void events.push(event),
    idle: () => Promise.resolve(),
  };
}
