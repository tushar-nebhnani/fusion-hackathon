import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit, type Store } from "express-rate-limit";
import { AppError } from "../errors/app-error.js";
import { sessionUser } from "./auth.js";

// Per-client limit over a one minute window, answered with the standard error.
// A client is the signed-in user where the session has been read (the
// per-route limits), so changing address does not reset an account's limit;
// otherwise it is the address (the API-wide limit, which runs first).
// Without a `store` the counts live in this process, which only suits tests
// and a single instance; server.ts passes the Redis one.
export function rateLimiter(limit: number, store?: Store): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    ...(store && { store }),
    keyGenerator: (req, res) => {
      const user = sessionUser(res);
      return user ? `user:${user.id}` : ipKeyGenerator(req.ip ?? "");
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError("Too many requests, slow down", 429, "RATE_LIMITED"));
    },
  });
}
