import express, { type Express } from "express";
import type { AdvisorAccess, AdvisorVisible, EnqueueAlert } from "./controllers/advisor.controller.js";
import type { AuthCookieOptions } from "./controllers/auth.controller.js";
import { auditTrail } from "./middleware/audit.js";
import { loadSession, requireAuth, requireBank, sessionUser } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { createErrorHandler, notFoundHandler } from "./middleware/error-handler.js";
import {
  createMemoryIdempotencyStore,
  idempotency,
  type IdempotencyStore,
} from "./middleware/idempotency.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import type { RateLimitStoreFactory } from "./middleware/rate-limit-store.js";
import { requestLog } from "./middleware/request-log.js";
import { securityAuditLogger } from "./middleware/security-audit.js";
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
import type { Logger } from "./services/logs/index.js";
import type { InputService } from "./services/input/service.js";

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
    // session is read. Local development only; createApp refuses it in production.
    devUser?: AuthUser;
  };
  climate: ClimateService;
  // Where security audit events go. Without one, requests still get an id
  // but nothing is recorded.
  audit?: AuditRecorder;
  // One line per request, and where unexpected errors are written. Without
  // one, requests are not logged and errors go to the console.
  logger?: Logger;
  // Where rate limit counts are kept. Without one they live in this process,
  // which only suits tests and a single instance.
  rateLimitStore?: RateLimitStoreFactory;
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
    // assertAccess for a whole list in one read; GET /advisor/businesses uses
    // it when given, and asks assertAccess per business when not
    visible?: AdvisorVisible;
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
  // Advisor answers per minute per signed-in user (chat and damage report):
  // each one runs the agent, up to ADVISOR_MAX_ITERATIONS model calls
  advisorAnswerRateLimit?: number;
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
  // Below auditTrail, which sets the request id every line carries
  if (deps.logger) app.use(requestLog(deps.logger));
  // Every endpoint is rate limited and honours Idempotency-Key. New routes
  // mounted below inherit both.
  // Logs refused and failed requests to the console, before anything can refuse
  app.use(securityAuditLogger);
  const store = (name: string) => deps.rateLimitStore?.(name);
  app.use(rateLimiter(deps.rateLimit ?? 120, store("api")));
  // Also refuses writes from websites that are not ours (CSRF)
  app.use(cors(deps.auth.allowedOrigins ?? []));
  app.use(express.json({ limit: "10kb" }));

  // The session is read before idempotency so that each user's keys are
  // kept apart. It does not reject; the routes below say who they need.
  // ---- AUTH DISABLED ----------------------------------------------------
  // With a devUser, sign-in is switched off: every request is that user, so
  // requireAuth and requireBank always pass. To turn sign-in back on, stop
  // passing auth.devUser in server.ts; this line then reads real sessions.
  // app.use(loadSession(deps.auth.service));
  const devUser = deps.auth.devUser;
  if (devUser && process.env.NODE_ENV === "production") {
    throw new Error("auth.devUser switches sign-in off and cannot be used in production");
  }
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
      logger: deps.logger,
    }),
  );

  // Open to everyone
  app.use("/health", healthRouter(deps));
  app.use(
    "/auth",
    rateLimiter(deps.auth.rateLimit ?? AUTH.rateLimit, store("auth")),
    authRouter(deps.auth.service, deps.auth.cookie ?? { sameSite: "lax", secure: false }),
  );

  // Signed-in users only. New routes go below with `requireAuth` or `requireBank`.
  app.use(
    "/climate",
    rateLimiter(deps.climateRateLimit ?? 60, store("climate")),
    requireAuth,
    climateRouter(deps.climate),
  );
  // Every business's alerts, so bank officers only
  if (deps.alerts) app.use("/alerts", requireBank, alertsRouter(deps.alerts));
  if (deps.finance) {
    app.use(
      "/finance",
      rateLimiter(deps.finance.rateLimit ?? FINANCE.rateLimit, store("finance")),
      requireAuth,
      financeRouter(deps.finance),
    );
  }
  if (deps.evaluator) {
    app.use(
      "/evaluate",
      rateLimiter(deps.evaluator.rateLimit ?? EVALUATOR.rateLimit, store("evaluate")),
      requireAuth,
      evaluatorRouter(deps.evaluator),
    );
  }
  // Guards its own paths: it is mounted at the root
  if (deps.input) {
    app.use(inputRouter(deps.input.service, { ...deps.input.options, rateLimitStore: store("input") }));
  }
  // Signed in to chat; the bank's own actions are bank officers only (see the router)
  if (deps.advisor) {
    app.use(
      "/advisor",
      rateLimiter(deps.advisorRateLimit ?? 30, store("advisor")),
      requireAuth,
      advisorRouter(deps.advisor.service, {
        devRoutes: deps.advisor.devRoutes,
        assertAccess: deps.advisor.assertAccess,
        answerLimit: rateLimiter(deps.advisorAnswerRateLimit ?? 5, store("advisor-answers")),
        visible: deps.advisor.visible,
        enqueue: deps.advisor.enqueue,
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
