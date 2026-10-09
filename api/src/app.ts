import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { AuthCookieOptions } from "./controllers/auth.controller.js";
import { loadSession, requireAuth, requireBank, sessionUser } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import {
  createMemoryIdempotencyStore,
  idempotency,
  type IdempotencyStore,
} from "./middleware/idempotency.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { alertsRouter } from "./routes/alerts.js";
import { authRouter } from "./routes/auth.js";
import { climateRouter } from "./routes/climate.js";
import { healthRouter, type HealthDeps } from "./routes/health.js";
import type { AlertReader } from "./services/alerts/reader.js";
import { AUTH } from "./services/auth/config.js";
import type { AuthService } from "./services/auth/service.js";
import type { ClimateService } from "./services/climate/profile.service.js";
import { inputRouter, type InputRouterOptions } from "./services/input/index.js";
import type { InputService } from "./services/input/service.js";

// api/public, whether this runs from src/ or dist/
const DEMO_DIR = fileURLToPath(new URL("../public", import.meta.url));

export interface AppDeps extends HealthDeps {
  // Sign in with Google and the sessions behind every protected route
  auth: {
    service: AuthService;
    // Frontend origins that may call the API with the session cookie
    allowedOrigins?: readonly string[];
    cookie?: AuthCookieOptions;
    // Requests per minute per client on /auth
    rateLimit?: number;
  };
  climate: ClimateService;
  // Read side of the alert system. /alerts is mounted only when it is given
  alerts?: AlertReader;
  // Defaults to an in-process store, which only suits tests and one instance
  idempotency?: IdempotencyStore;
  // Requests per minute per client across the whole API
  rateLimit?: number;
  // Stricter limit on /climate; each request can cost upstream calls
  climateRateLimit?: number;
  // Input service. /businesses, /loans and /seed are mounted only when it is given
  input?: { service: InputService; options?: InputRouterOptions };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // Every endpoint is rate limited and honours Idempotency-Key. New routes
  // mounted below inherit both.
  app.use(rateLimiter(deps.rateLimit ?? 120));
  // Also refuses writes from websites that are not ours (CSRF)
  app.use(cors(deps.auth.allowedOrigins ?? []));
  app.use(express.json({ limit: "10kb" }));

  // Static MVP demo page; it calls the routes below from the same origin
  app.use("/demo", express.static(DEMO_DIR));

  // The session is read before idempotency so that each user's keys are
  // kept apart. It does not reject; the routes below say who they need.
  app.use(loadSession(deps.auth.service));
  app.use(
    idempotency(deps.idempotency ?? createMemoryIdempotencyStore(), {
      subject: (_req, res) => sessionUser(res)?.id ?? null,
    }),
  );

  // Open to everyone
  app.use("/health", healthRouter(deps));
  app.use(
    "/auth",
    rateLimiter(deps.auth.rateLimit ?? AUTH.rateLimit),
    authRouter(deps.auth.service, deps.auth.cookie ?? { sameSite: "lax", secure: false }),
  );

  // Signed-in users only. New routes go below with `requireAuth` or `requireBank`.
  app.use(
    "/climate",
    rateLimiter(deps.climateRateLimit ?? 60),
    requireAuth,
    climateRouter(deps.climate),
  );
  // Every business's alerts, so bank officers only
  if (deps.alerts) app.use("/alerts", requireBank, alertsRouter(deps.alerts));
  // Guards its own paths: it is mounted at the root
  if (deps.input) app.use(inputRouter(deps.input.service, deps.input.options));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
