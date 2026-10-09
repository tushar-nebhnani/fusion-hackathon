import type { RunLogger } from "../ports.js";

const line = (level: string, message: string) =>
  `${new Date().toISOString()} monitor ${level}: ${message}`;

// Stand-in for the logs system
export const consoleRunLogger: RunLogger = {
  info: (message, detail) =>
    detail === undefined ? console.log(line("info", message)) : console.log(line("info", message), detail),
  warn: (message, detail) =>
    detail === undefined ? console.warn(line("warn", message)) : console.warn(line("warn", message), detail),
  error: (message, detail) =>
    detail === undefined
      ? console.error(line("error", message))
      : console.error(line("error", message), detail),
};
