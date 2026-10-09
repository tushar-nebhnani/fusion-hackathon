import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, NotFoundError } from "../errors/app-error.js";

// Return a safe error when a route does not exist.
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

// Avoid exposing internal error details to API clients.
function getSafeHttpError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  if (
    !(err instanceof Error) ||
    !("status" in err) ||
    typeof err.status !== "number" ||
    err.status < 400 ||
    err.status >= 500
  ) {
    return null;
  }

  if (err.status === 413) {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large",
    };
  }

  if (err.status === 429) {
    return {
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many requests, slow down",
    };
  }

  return {
    status: err.status,
    code: "BAD_REQUEST",
    message: "Invalid request",
  };
}

// Must be registered after all routes; Express needs the 4-argument signature
export const createErrorHandler =
  (logger: Pick<Console, "error"> = console): ErrorRequestHandler =>
  (err, _req, res, _next) => {
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

    // Handle common HTTP errors without exposing parser internals.
    const safeHttpError = getSafeHttpError(err);

    if (safeHttpError) {
      res.locals.errorCode = safeHttpError.code;
      res.status(safeHttpError.status).json({
        error: {
          code: safeHttpError.code,
          message: safeHttpError.message,
        },
      });
      return;
    }

    res.locals.errorCode = "INTERNAL_ERROR";
    // The detail stays in the server's log, whatever NODE_ENV says. The
    // request id, also sent as X-Request-Id, is how to find this line.
    logger.error(`request ${String(res.locals.requestId ?? "-")} failed:`, err);
    res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  };

export const errorHandler = createErrorHandler();
