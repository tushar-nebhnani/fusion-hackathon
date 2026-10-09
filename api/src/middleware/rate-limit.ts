import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../errors/app-error.js";

// Per-client limit over a one minute window, answered with the standard error
export function rateLimiter(limit: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError("Too many requests, slow down", 429, "RATE_LIMITED"));
    },
  });
}
