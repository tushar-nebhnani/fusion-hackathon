import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { LOGS, type LogThreshold } from "./config.js";
import { RANK, type LogRecord, type LogSink } from "./logger.js";

const DAY_MS = 86_400_000;
// Columns of their own; everything else on a line goes into `fields`
const COLUMNS = new Set(["time", "level", "service", "msg", "requestId", "userId"]);

export interface DbLogSink {
  sink: LogSink;
  // Writes what is buffered. Never rejects.
  flush(): Promise<void>;
  // Stops the timer and writes what is left, for shutdown
  stop(): Promise<void>;
  // Removes rows older than LOGS.retentionDays
  purgeExpired(): Promise<number>;
}

export interface DbLogSinkOptions {
  // Lines below this are not stored. "silent" stores nothing.
  level?: LogThreshold;
  now?: () => Date;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

function toRow(record: LogRecord): Prisma.AppLogCreateManyInput {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!COLUMNS.has(key) && value !== undefined) fields[key] = value;
  }
  const time = new Date(record.time);
  return {
    time: Number.isNaN(time.getTime()) ? new Date() : time,
    level: record.level,
    service: record.service.slice(0, 32),
    message: record.msg.slice(0, LOGS.db.maxMessageChars),
    requestId: text(record.requestId, 64),
    userId: text(record.userId, 64),
    // Already JSON-safe and redacted by the logger
    fields: Object.keys(fields).length > 0 ? (fields as Prisma.InputJsonObject) : Prisma.DbNull,
  };
}

// Stores log lines in `app_logs`, in batches, so a request never waits for
// its own log line. Logging must not fail or slow the process: a batch that
// cannot be written is dropped and reported once on stderr, and the buffer
// is capped while the database is away.
export function createDbLogSink(prisma: PrismaClient, options: DbLogSinkOptions = {}): DbLogSink {
  const threshold = RANK[options.level ?? "info"];
  const now = options.now ?? (() => new Date());
  let buffer: Prisma.AppLogCreateManyInput[] = [];
  let writing: Promise<void> = Promise.resolve();
  let failing = false;
  let dropped = 0;

  const report = (reason: string) => {
    // Not through the logger: that would come straight back here
    if (!failing) process.stderr.write(`logs: lines are not being stored in app_logs (${reason})\n`);
    failing = true;
  };

  function flush(): Promise<void> {
    if (buffer.length === 0) return writing;
    const batch = buffer;
    buffer = [];
    writing = writing
      .then(() => prisma.appLog.createMany({ data: batch }))
      .then(
        () => {
          if (failing) process.stderr.write(`logs: storing lines again; ${String(dropped)} were lost\n`);
          failing = false;
          dropped = 0;
        },
        (error: unknown) => {
          dropped += batch.length;
          report(error instanceof Error ? error.name : "unknown error");
        },
      );
    return writing;
  }

  const timer = setInterval(() => void flush(), LOGS.db.flushMs);
  // The HTTP server keeps the process alive; this timer should not
  timer.unref();

  return {
    sink(record) {
      if (RANK[record.level] < threshold) return;
      if (buffer.length >= LOGS.db.maxBuffered) {
        dropped += 1;
        report("the buffer is full");
        return;
      }
      buffer.push(toRow(record));
      if (buffer.length >= LOGS.db.batchSize) void flush();
    },
    flush,
    async stop() {
      clearInterval(timer);
      await flush();
    },
    async purgeExpired() {
      const before = new Date(now().getTime() - LOGS.retentionDays * DAY_MS);
      const { count } = await prisma.appLog.deleteMany({ where: { time: { lt: before } } });
      return count;
    },
  };
}
