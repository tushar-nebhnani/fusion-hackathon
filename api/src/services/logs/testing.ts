import { createLogger, type Logger, type LogRecord } from "./logger.js";

// A logger that keeps its lines, for tests that check what was logged
export function memoryLogger(service = "test"): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = createLogger({
    service,
    level: "debug",
    sink: (record) => records.push(record),
    now: () => new Date("2026-10-09T06:00:00Z"),
  });
  return { logger, records };
}
