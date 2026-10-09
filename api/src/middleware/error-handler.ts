
import type { ErrorRequestHandler, RequestHandler } from "express";
import { env } from "../config/env.js";
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

// Must be registered after all routes.
// Express error handlers require four parameters.
export const errorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next,
) => {
  // Handle errors intentionally created by our application.
  if (err instanceof AppError) {
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
    res.status(safeHttpError.status).json({
      error: {
        code: safeHttpError.code,
        message: safeHttpError.message,
      },
    });
    return;
  }

  // Log unexpected errors on the server, not in the API response.
 
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "api_internal_error",
      method: req.method,
      path: req.path,
      status: 500,
      errorType: err instanceof Error ? err.name : "UnknownError",
    }),
  );


  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
};