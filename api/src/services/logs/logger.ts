import { LOGS, type LogFormat, type LogThreshold } from "./config.js";
import { logContext, type LogFields } from "./context.js";

export type LogLevel = Exclude<LogThreshold, "silent">;

export const RANK: Record<LogThreshold, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const RESERVED = new Set(["time", "level", "service", "msg", "detail", "err"]);
const IST_OFFSET_MS = 330 * 60_000;

// Shaped like the parts of Console the services already take, so it can be
// passed wherever `Pick<Console, ...>` or the monitor's RunLogger is expected
export interface Logger {
  debug(message: string, ...detail: unknown[]): void;
  info(message: string, ...detail: unknown[]): void;
  warn(message: string, ...detail: unknown[]): void;
  error(message: string, ...detail: unknown[]): void;
  // Same as info
  log(message: string, ...detail: unknown[]): void;
  // A logger whose lines all carry `fields`, e.g. { component: "climate" }
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  time: string;
  level: LogLevel;
  service: string;
  msg: string;
  [field: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  // Which process wrote the line: api, monitor, alerts-worker
  service: string;
  level?: LogThreshold;
  format?: LogFormat;
  // Defaults to stdout, and stderr for warn and error
  sink?: LogSink;
  now?: () => Date;
  fields?: LogFields;
}

export function istTimestamp(date: Date): string {
  return `${new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 23)}+05:30`;
}

interface SerializedError {
  name: string;
  message: string;
  code?: unknown;
  status?: unknown;
  stack?: string;
  cause?: unknown;
}

function serializeError(error: Error, depth: number): SerializedError {
  const extra = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
  const status = extra.status ?? extra.statusCode;
  return {
    name: error.name,
    message: error.message,
    ...(extra.code !== undefined && { code: extra.code }),
    ...(status !== undefined && { status }),
    ...(error.stack !== undefined && { stack: error.stack }),
    ...(error.cause !== undefined && { cause: clean(error.cause, depth + 1, new WeakSet()) }),
  };
}

// A JSON-safe copy with secrets taken out. Never throws on odd input:
// cycles, bigints, Prisma decimals and deep objects all become something printable.
function clean(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : istTimestamp(value);
  if (value instanceof Error) return serializeError(value, depth);
  if (seen.has(value)) return "[circular]";
  if (depth >= LOGS.maxDepth) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item: unknown) => clean(item, depth + 1, seen));
  // Decimal and similar wrappers print as their value
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return clean((toJSON as () => unknown).call(value), depth + 1, seen);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = LOGS.redactKeys.test(key) ? "[redacted]" : clean(item, depth + 1, seen);
  }
  return out;
}

function cleanFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED.has(key)) continue;
    out[key] = LOGS.redactKeys.test(key) ? "[redacted]" : clean(value, 1, new WeakSet());
  }
  return out;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function formatPretty(record: LogRecord): string {
  const { time, level, service, msg, detail, err, ...fields } = record;
  const parts = [time, level.toUpperCase().padEnd(5), service, msg];
  for (const [key, value] of Object.entries(fields)) parts.push(`${key}=${stringify(value)}`);
  if (detail !== undefined) parts.push(stringify(detail));
  let line = parts.join(" ");
  if (err !== undefined) {
    const error = err as SerializedError;
    line += `\n  ${error.stack ?? `${error.name}: ${error.message}`}`;
  }
  return line;
}

export function consoleSink(format: LogFormat): LogSink {
  return (record) => {
    const line = format === "json" ? JSON.stringify(record) : formatPretty(record);
    const stream = record.level === "warn" || record.level === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };
}

// Every sink gets every line; one that throws does not stop the others
export function teeSinks(...sinks: LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch (failure) {
        process.stderr.write(`log sink failed: ${String(failure)}\n`);
      }
    }
  };
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = RANK[options.level ?? "info"];
  const sink = options.sink ?? consoleSink(options.format ?? "pretty");
  const now = options.now ?? (() => new Date());
  const bound = cleanFields(options.fields ?? {});

  const write = (level: LogLevel, message: string, args: unknown[]) => {
    if (RANK[level] < threshold) return;
    try {
      // The first Error is the error; anything else is detail
      const errorIndex = args.findIndex((arg) => arg instanceof Error);
      const rest = args.filter((_arg, index) => index !== errorIndex);
      const record: LogRecord = {
        time: istTimestamp(now()),
        level,
        service: options.service,
        msg: String(message),
        ...cleanFields(logContext() ?? {}),
        ...bound,
      };
      if (rest.length > 0) record.detail = clean(rest.length === 1 ? rest[0] : rest, 1, new WeakSet());
      if (errorIndex >= 0) record.err = serializeError(args[errorIndex] as Error, 1);
      sink(record);
    } catch (failure) {
      // Logging must never be the reason a request or a tick fails
      process.stderr.write(`log write failed: ${String(failure)} (${String(message)})\n`);
    }
  };

  return {
    debug: (message, ...detail) => write("debug", message, detail),
    info: (message, ...detail) => write("info", message, detail),
    warn: (message, ...detail) => write("warn", message, detail),
    error: (message, ...detail) => write("error", message, detail),
    log: (message, ...detail) => write("info", message, detail),
    child: (fields) => createLogger({ ...options, sink, fields: { ...options.fields, ...fields } }),
  };
}
