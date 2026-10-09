import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, NotFoundError } from "../errors/app-error.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
};

// Errors raised by Express itself (e.g. malformed JSON bodies) carry a status
function isHttpError(err: unknown): err is Error & { status: number } {
  return (
    err instanceof Error &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status < 500
  );
}

// Must be registered after all routes; Express needs the 4-argument signature
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    // Read by the audit trail as the reason a request did not succeed
    res.locals.errorCode = err.code;
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        step: err.step,
        details: err.details,
      },
    });
    return;
  }

  if (isHttpError(err)) {
    res.locals.errorCode = "BAD_REQUEST";
    res.status(err.status).json({
      error: { code: "BAD_REQUEST", message: err.message },
    });
    return;
  }

  res.locals.errorCode = "INTERNAL_ERROR";
  // The detail stays in the server's log, whatever NODE_ENV says. The
  // request id, also sent as X-Request-Id, is how to find this line.
  console.error(`request ${String(res.locals.requestId ?? "-")} failed:`, err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
};
