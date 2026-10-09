import type { Request, RequestHandler, Response } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors/app-error.js";
import { AUTH } from "../services/auth/config.js";
import type { AuthService, AuthUser } from "../services/auth/service.js";

// Longer than any token the API issues; anything bigger is not looked up
const MAX_TOKEN_CHARS = 128;

// The session cookie's value, or null. Tokens are base64url, so the value
// needs no decoding.
export function sessionToken(req: Request): string | null {
  for (const part of (req.get("Cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === AUTH.cookieName) {
      const value = part.slice(at + 1).trim();
      return value.length > 0 && value.length <= MAX_TOKEN_CHARS ? value : null;
    }
  }
  return null;
}

// Works out who is calling, once per request, and never rejects: the routes
// decide with `requireAuth` and `requireBank` whether a user is needed.
// Mounted above the idempotency middleware, which keeps each user's keys apart.
export function loadSession(auth: AuthService): RequestHandler {
  return async (req, res, next) => {
    const token = sessionToken(req);
    res.locals.user = token ? await auth.authenticate(token) : null;
    next();
  };
}

export function sessionUser(res: Response): AuthUser | null {
  return (res.locals.user as AuthUser | null | undefined) ?? null;
}

export function requireUser(res: Response): AuthUser {
  const user = sessionUser(res);
  if (!user) throw new UnauthorizedError("Sign in to use this endpoint");
  return user;
}

export const requireAuth: RequestHandler = (_req, res, next) => {
  requireUser(res);
  next();
};

export const requireBank: RequestHandler = (_req, res, next) => {
  if (requireUser(res).role !== "bank") throw new ForbiddenError("Only a bank officer can do this");
  next();
};
