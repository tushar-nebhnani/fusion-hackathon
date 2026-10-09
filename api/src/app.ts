import { fileURLToPath } from "node:url";
import { securityAuditLogger } from "./middleware/security-audit.js";
import express, { type Express } from "express";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import {
  createMemoryIdempotencyStore,
  idempotency,
  type IdempotencyStore,
} from "./middleware/idempotency.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { alertsRouter } from "./routes/alerts.js";
import { climateRouter } from "./routes/climate.js";
import { healthRouter, type HealthDeps } from "./routes/health.js";
import type { AlertReader } from "./services/alerts/reader.js";
import type { ClimateService } from "./services/climate/profile.service.js";

// api/public, whether this runs from src/ or dist/
const DEMO_DIR = fileURLToPath(new URL("../public", import.meta.url));

export interface AppDeps extends HealthDeps {
  climate: ClimateService;
  // Read side of the alert system. /alerts is mounted only when it is given
  alerts?: AlertReader;
  // Defaults to an in-process store, which only suits tests and one instance
  idempotency?: IdempotencyStore;
  // Requests per minute per client across the whole API
  rateLimit?: number;
  // Stricter limit on /climate; each request can cost upstream calls
  climateRateLimit?: number;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
app.disable("x-powered-by");

  // Baseline HTTP security headers
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    next();
  });

// Baseline security headers for API and same-origin demo responses.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
  // Every endpoint is rate limited and honours Idempotency-Key. New routes
  // mounted below inherit both.
  app.use(securityAuditLogger);
  app.use(rateLimiter(deps.rateLimit ?? 120));
  app.use(express.json({ limit: "10kb" }));
  app.use(idempotency(deps.idempotency ?? createMemoryIdempotencyStore()));

  // Static MVP demo page; it calls the routes below from the same origin
  app.use("/demo", express.static(DEMO_DIR));
  app.use("/health", healthRouter(deps));
  app.use("/climate", rateLimiter(deps.climateRateLimit ?? 60), climateRouter(deps.climate));
  if (deps.alerts) app.use("/alerts", alertsRouter(deps.alerts));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
