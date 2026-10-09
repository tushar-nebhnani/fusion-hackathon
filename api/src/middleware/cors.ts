import type { Request, RequestHandler } from "express";
import { AppError } from "../errors/app-error.js";

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE";
const ALLOWED_HEADERS = "Content-Type, Idempotency-Key";
const EXPOSED_HEADERS = "Idempotency-Replayed, RateLimit, RateLimit-Policy, Retry-After, X-Request-Id";
const PREFLIGHT_MAX_AGE_SECONDS = 600;

// A page on the API's own origin
function sameOrigin(req: Request, origin: string): boolean {
  try {
    return new URL(origin).host === req.get("Host");
  } catch {
    return false;
  }
}

// Lets the listed frontends call the API with the session cookie, and
// refuses writes from any other website. Browsers attach `Origin` to every
// cross-origin request and every write, so this check is also the CSRF
// protection the cookie needs. Requests without it (curl, servers) pass.
// "*" allows every origin; auth config drops it in production.
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  const anyOrigin = allowed.has("*");

  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.get("Origin");
    if (origin === undefined || sameOrigin(req, origin)) {
      next();
      return;
    }
    if (!anyOrigin && !allowed.has(origin)) {
      // A read gets no CORS headers, so the browser keeps the answer from the page
      if (SAFE_METHODS.has(req.method)) {
        next();
        return;
      }
      throw new AppError(`Origin ${origin.slice(0, 200)} is not allowed`, 403, "ORIGIN_NOT_ALLOWED");
    }

    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    });
    if (req.method === "OPTIONS" && req.get("Access-Control-Request-Method") !== undefined) {
      res
        .set({
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": ALLOWED_HEADERS,
          "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
        })
        .status(204)
        .end();
      return;
    }
    next();
  };
}
