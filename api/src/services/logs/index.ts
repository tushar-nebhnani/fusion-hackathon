import { loadLogsEnv } from "./config.js";
import { consoleSink, createLogger, teeSinks, type Logger, type LogSink } from "./logger.js";

export { LOGS, loadLogsEnv, type LogsEnv } from "./config.js";
export { logContext, withLogContext, type LogFields } from "./context.js";
export { createDbLogSink, type DbLogSink } from "./db-sink.js";
export {
  consoleSink,
  createLogger,
  formatPretty,
  istTimestamp,
  teeSinks,
  type LogLevel,
  type Logger,
  type LogRecord,
  type LogSink,
} from "./logger.js";

// The root logger of one process, from LOG_LEVEL and LOG_FORMAT. Lines go to
// the console, and to `also` as well when it is given (the `app_logs` sink).
export function createLoggerFromEnv(
  service: string,
  source: NodeJS.ProcessEnv = process.env,
  also?: LogSink,
): Logger {
  const env = loadLogsEnv(source);
  const sink = also ? teeSinks(consoleSink(env.format), also) : undefined;
  return createLogger({ service, level: env.level, format: env.format, sink });
}
