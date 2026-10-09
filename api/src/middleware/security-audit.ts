
import type { RequestHandler } from "express";

export const securityAuditLogger: RequestHandler = (
  req,
  res,
  next,
) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    // Log rejected requests and server errors, not every successful request.
    if (res.statusCode >= 400) {
      const event = {
        timestamp: new Date().toISOString(),
        event:
          res.statusCode >= 500
            ? "api_server_error"
            : "api_request_rejected",
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      };

      const message = JSON.stringify(event);

      if (res.statusCode >= 500) {
        console.error(message);
      } else {
        console.warn(message);
      }
    }
  });

  next();
};