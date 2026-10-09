import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import type { AdvisorAccess, EnqueueAlert } from "./controllers/advisor.controller.js";
import type { AuthCookieOptions } from "./controllers/auth.controller.js";
import { auditTrail } from "./middleware/audit.js";
import { loadSession, requireAuth, requireBank, sessionUser } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import {
  createMemoryIdempotencyStore,
  idempotency,
  type IdempotencyStore,
} from "./middleware/idempotency.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { advisorRouter } from "./routes/advisor.js";
import { alertsRouter } from "./routes/alerts.js";
import { authRouter } from "./routes/auth.js";
import { climateRouter } from "./routes/climate.js";
import { evaluatorRouter, type EvaluatorRouterDeps } from "./routes/evaluator.js";
import { financeRouter, type FinanceRouterDeps } from "./routes/finance.js";
import { healthRouter, type HealthDeps } from "./routes/health.js";
import type { Advisor } from "./services/advisor/index.js";
import type { AlertReader } from "./services/alerts/reader.js";
import type { AuditRecorder } from "./services/audit/recorder.js";
import { AUTH } from "./services/auth/config.js";
import type { AuthService, AuthUser } from "./services/auth/service.js";
import type { ClimateService } from "./services/climate/profile.service.js";
import { EVALUATOR } from "./services/evaluator/config.js";
import { FINANCE } from "./services/finance/index.js";
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
    // AUTH DISABLED: when given, every request acts as this user and no
    // session is read. Local development only; server.ts refuses it in production.
    devUser?: AuthUser;
  };
  climate: ClimateService;
  // Where security audit events go. Without one, requests still get an id
  // but nothing is recorded.
  audit?: AuditRecorder;
  // Reverse proxies in front of the API. Needed for per-client rate limits
  // there; left at 0, a client could otherwise forge its address.
  trustProxy?: number;
  // Read side of the alert system. /alerts is mounted only when it is given
  alerts?: AlertReader;
  // Chat advisor. /advisor is mounted only when it is given. Every route that
  // names a business or loan asks assertAccess first.
  advisor?: {
    service: Advisor;
    devRoutes: boolean;
    assertAccess: AdvisorAccess;
    // The alert outbox; the dev fake-alert route queues an email through it
    enqueue?: EnqueueAlert;
  };
  // Defaults to an in-process store, which only suits tests and one instance
  idempotency?: IdempotencyStore;
  // Requests per minute per client across the whole API
  rateLimit?: number;
  // Stricter limit on /climate; each request can cost upstream calls
  climateRateLimit?: number;
  // Stricter limit on /advisor; each request can cost several model calls
  advisorRateLimit?: number;
  // Input service. /businesses, /loans and /seed are mounted only when it is given
  input?: { service: InputService; options?: InputRouterOptions };
  // Evaluator. /evaluate is mounted only when it is given
  evaluator?: EvaluatorRouterDeps & {
    // Requests per minute per client on /evaluate
    rateLimit?: number;
  };
  // Finance service. /finance is mounted only when it is given
  finance?: FinanceRouterDeps & {
    // Requests per minute per client on /finance; a profile can cost a climate lookup
    rateLimit?: number;
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // First, so that errors and rate-limited answers carry them too
  app.use(securityHeaders({ hsts: deps.auth.cookie?.secure }));
  if (deps.trustProxy) app.set("trust proxy", deps.trustProxy);
  // Above everything that can refuse a request, so refusals are recorded too
  app.use(auditTrail(deps.audit));
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
  // ---- AUTH DISABLED ----------------------------------------------------
  // With a devUser, sign-in is switched off: every request is that user, so
  // requireAuth and requireBank always pass. To turn sign-in back on, stop
  // passing auth.devUser in server.ts; this line then reads real sessions.
  // app.use(loadSession(deps.auth.service));
  const devUser = deps.auth.devUser;
  app.use(
    devUser
      ? (_req, res, next) => {
          res.locals.user = devUser;
          next();
        }
      : loadSession(deps.auth.service),
  );
  // ------------------------------------------------------------------------
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
  if (deps.finance) {
    app.use(
      "/finance",
      rateLimiter(deps.finance.rateLimit ?? FINANCE.rateLimit),
      requireAuth,
      financeRouter(deps.finance),
    );
  }
  if (deps.evaluator) {
    app.use(
      "/evaluate",
      rateLimiter(deps.evaluator.rateLimit ?? EVALUATOR.rateLimit),
      requireAuth,
      evaluatorRouter(deps.evaluator),
    );
  }
  // Guards its own paths: it is mounted at the root
  if (deps.input) app.use(inputRouter(deps.input.service, deps.input.options));
  // Signed in to chat; the bank's own actions are bank officers only (see the router)
  if (deps.advisor) {
    app.use(
      "/advisor",
      rateLimiter(deps.advisorRateLimit ?? 30),
      requireAuth,
      advisorRouter(deps.advisor.service, {
        devRoutes: deps.advisor.devRoutes,
        assertAccess: deps.advisor.assertAccess,
        enqueue: deps.advisor.enqueue,
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
