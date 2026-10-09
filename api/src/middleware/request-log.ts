import type { RequestHandler } from "express";
import { LOGS } from "../services/logs/config.js";
import { withLogContext } from "../services/logs/context.js";
import type { Logger } from "../services/logs/logger.js";
import { sessionUser } from "./auth.js";

// One line per request, and the request id on every line logged while it
// runs. Mount after auditTrail, which sets the id. The query string, the
// body and the headers are never logged.
export function requestLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
    const path = (req.originalUrl.split("?")[0] ?? "").slice(0, LOGS.maxPathChars);
    let done = false;

    const line = (aborted: boolean) => {
      if (done) return;
      done = true;
      const status = res.statusCode;
      const errorCode: unknown = res.locals.errorCode;
      const fields = {
        requestId,
        method: req.method,
        path,
        status,
        ms: Math.round(performance.now() - started),
        userId: sessionUser(res)?.id,
        ...(typeof errorCode === "string" && { errorCode }),
        ...(res.getHeader("Idempotency-Replayed") !== undefined && { replayed: true }),
        ...(aborted && { aborted: true }),
      };
      const log = logger.child(fields);
      if (status >= 500) log.error("request");
      else if (aborted || status >= 400) log.warn("request");
      else if (LOGS.quietPaths.some((quiet) => path === quiet || path.startsWith(`${quiet}/`)))
        log.debug("request");
      else log.info("request");
    };
    res.on("finish", () => line(false));
    // The client went away before the answer was sent
    res.on("close", () => line(!res.writableFinished));

    withLogContext({ requestId }, next);
  };
}
