import "dotenv/config";
import { z } from "zod";

// Read apart from config/env.ts on purpose: a bad log setting must never stop
// a process. An invalid value falls back to its default.

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogThreshold = (typeof LOG_LEVELS)[number];
export type LogFormat = "json" | "pretty";

export interface LogsEnv {
  level: LogThreshold;
  // json for a log collector, pretty for a terminal
  format: LogFormat;
  // Lines at this level or above are also stored in `app_logs`; silent stores none
  dbLevel: LogThreshold;
}

export const LOGS = {
  // Longest path kept in a request line; ids beyond it are not needed to find one
  maxPathChars: 120,
  // How deep a logged object is copied before the rest is cut
  maxDepth: 6,
  // Keys whose values never reach a log line, matched anywhere in the key
  redactKeys: /pass(word)?|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|session/i,
  // Requests logged at debug instead of info: polled, and noisy at info
  quietPaths: ["/health"],
  // Days a row stays in `app_logs`
  retentionDays: 14,
  db: {
    // Rows written in one insert, and the longest a line waits for one
    batchSize: 100,
    flushMs: 2_000,
    // Lines kept while the database is away; beyond it they are dropped
    maxBuffered: 5_000,
    maxMessageChars: 2_000,
  },
} as const;

export function loadLogsEnv(source: NodeJS.ProcessEnv = process.env): LogsEnv {
  const production = source.NODE_ENV === "production";
  const parsed = z
    .object({
      LOG_LEVEL: z.enum(LOG_LEVELS).catch("info"),
      LOG_FORMAT: z.enum(["json", "pretty"]).catch(production ? "json" : "pretty"),
      LOG_DB_LEVEL: z.enum(LOG_LEVELS).catch("info"),
    })
    .parse({
      LOG_LEVEL: source.LOG_LEVEL ?? "info",
      LOG_FORMAT: source.LOG_FORMAT ?? "",
      LOG_DB_LEVEL: source.LOG_DB_LEVEL ?? "info",
    });
  return { level: parsed.LOG_LEVEL, format: parsed.LOG_FORMAT, dbLevel: parsed.LOG_DB_LEVEL };
}
