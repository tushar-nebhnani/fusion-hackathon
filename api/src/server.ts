import { createApp } from "./app.js";
import { CLIMATE } from "./config/climate.js";
import { connectDb, disconnectDb, prisma } from "./config/db.js";
import { env } from "./config/env.js";
import { startClimateRefresh } from "./jobs/climate-refresh.js";
import { createOncePerInterval } from "./jobs/once-per-interval.js";
import { createRedisRateLimitStores } from "./middleware/rate-limit-store.js";
import { createRedis } from "./config/redis.js";
import { createAdvisorFromEnv } from "./services/advisor/bootstrap.js";
import { loadAlertsConfig } from "./services/alerts/config.js";
import { createEnqueue } from "./services/alerts/enqueue.js";
import { createAlertReader } from "./services/alerts/reader.js";
import { createPrismaAuditRecorder } from "./services/audit/recorder.js";
import { loadAuthEnv } from "./services/auth/config.js";
import { createGoogleVerifier } from "./services/auth/google.js";
import { createAuthService } from "./services/auth/service.js";
import { createRedisCache } from "./services/cache/cache.js";
import { createOpenAiAgent } from "./services/climate/agent.js";
import { createOpenMeteoClient } from "./services/climate/open-meteo.js";
import { createClimateService } from "./services/climate/profile.service.js";
import { createEvaluatorService, createPrismaEvaluationStore } from "./services/evaluator/index.js";
import { chooseScorer, createFinanceService, loadFinanceEnv } from "./services/finance/index.js";
import { createMlClient, loadMlEnv } from "./services/ml/index.js";
import { createPrismaIdempotencyStore } from "./services/idempotency/prisma-store.js";
import { createOpenAiClassifier } from "./services/input/classifier/openai.js";
import { INPUT, loadInputEnv } from "./services/input/config.js";
import { createInputService } from "./services/input/service.js";
import { createDbLogSink, createLoggerFromEnv, loadLogsEnv } from "./services/logs/index.js";

await connectDb();

// Every line goes to the console and, at LOG_DB_LEVEL or above, to `app_logs`
const dbLogs = createDbLogSink(prisma, { level: loadLogsEnv().dbLevel });
const logger = createLoggerFromEnv("api", process.env, dbLogs.sink);
await dbLogs.purgeExpired();

const redis = createRedis(undefined, logger);
// Shared by every API instance: rate limit counts, and which instance runs a timed job
const rateLimitStore = createRedisRateLimitStores(redis, { logger });
const once = createOncePerInterval(redis, { logger });
const openMeteo = createOpenMeteoClient();
const idempotencyStore = createPrismaIdempotencyStore(prisma);
await idempotencyStore.purgeExpired();

const authEnv = loadAuthEnv();
const auth = createAuthService({
  prisma,
  googleClientId: authEnv.googleClientId,
  verifier: authEnv.googleClientId ? createGoogleVerifier(authEnv.googleClientId) : undefined,
  bankEmails: authEnv.bankEmails,
  bankDomains: authEnv.bankDomains,
  rolesEnforced: authEnv.rolesEnforced,
});
await auth.purgeExpired();

logger.info(
  authEnv.googleClientId
    ? "Sign in with Google: on"
    : "Sign in with Google: off (set GOOGLE_CLIENT_ID; protected routes answer 401 until then)",
);

if (!authEnv.rolesEnforced) {
  logger.warn("Roles: off (AUTH_ROLES_ENFORCED=false). Every signed-in user has bank access");
}

const agent =
  env.OPENAI_API_KEY && env.CLIMATE_AGENT_ENABLED === "true"
    ? createOpenAiAgent({ apiKey: env.OPENAI_API_KEY, model: env.CLIMATE_AGENT_MODEL })
    : undefined;
logger.info(
  agent ? `Climate agent: ${agent.version}` : "Climate agent: off (rule-based screening and scores)",
);

const climate = createClimateService({
  prisma,
  openMeteo,
  cache: createRedisCache(redis, { logger }),
  agent,
  logger,
});
const refresh = startClimateRefresh(climate, { logger, once });

const inputEnv = loadInputEnv();
const classifier =
  env.OPENAI_API_KEY && inputEnv.classifierEnabled
    ? createOpenAiClassifier({ apiKey: env.OPENAI_API_KEY, model: inputEnv.classifierModel })
    : undefined;
logger.info(
  classifier
    ? `Weather-impact classifier: ${classifier.model}`
    : "Weather-impact classifier: off (sector defaults)",
);
// Both of the input service's triggers are connected. A saved location warms
// its climate cell on a shorter history (CLIMATE.warmHistoryYears); an
// authorised loan and a new snapshot on a live loan each store a fresh
// finance profile.
const input = createInputService({
  prisma,
  llm: classifier,
  logger,
  ports: {
    climate: {
      warm: (point) => climate.getProfile(point, null, { historyYears: CLIMATE.warmHistoryYears }),
    },
    finance: {
      firstProfile: ({ businessId }) =>
        finance.getFinanceProfile(businessId, { trigger: "first_profile" }),
      recompute: ({ businessId }) => finance.getFinanceProfile(businessId, { trigger: "recompute" }),
    },
  },
});
const financeEnv = loadFinanceEnv();
const mlEnv = loadMlEnv();
logger.info(`ML service: ${mlEnv.url ?? "not configured, /ml answers 503"}`);
const scorer = chooseScorer(financeEnv);
logger.info(`Finance scorer: ${scorer.name}`);
const finance = createFinanceService({ prisma, businesses: input, climate, scorer, logger });
// Checks the climate and finance answers together; the advisor reads both only through it
const evaluator = createEvaluatorService({
  climate,
  businesses: input,
  finance,
  store: createPrismaEvaluationStore(prisma),
  logger,
});
const advisor = createAdvisorFromEnv({ prisma, evaluator, logger, once });
const inputRetryMs = INPUT.retryMinutes * 60_000;
const inputRetry = setInterval(() => {
  once("input-retry", inputRetryMs, async () => {
    await input.retryPending();
  }).catch((error: unknown) => {
    logger.error("input: retry of pending work failed", error);
  });
}, inputRetryMs);

const app = createApp({
  auth: {
    service: auth,
    allowedOrigins: authEnv.allowedOrigins,
    cookie: { sameSite: authEnv.cookieSameSite, secure: authEnv.cookieSecure },
  },
  idempotency: idempotencyStore,
  audit: createPrismaAuditRecorder(prisma, logger),
  logger,
  rateLimitStore,
  trustProxy: env.TRUST_PROXY,
  climate,
  input: {
    service: input,
    options: { seed: { enabled: env.NODE_ENV !== "production", file: inputEnv.seedFile } },
  },
  finance: { service: finance, assertAccess: (id, actor) => input.assertAccess(id, actor) },
  evaluator: { service: evaluator, assertAccess: (id, actor) => input.assertAccess(id, actor) },
  ml: { client: createMlClient({ url: mlEnv.url }) },
  alerts: createAlertReader(prisma),
  advisor: {
    service: advisor.advisor,
    devRoutes: advisor.config.enableDevRoutes,
    enqueue: createEnqueue({ prisma, config: loadAlertsConfig(), logger }),
    // The input service's ownership and sharing rule. The smes.json demo
    // businesses (never in production) stay open to every signed-in user.
    assertAccess: async (businessId, actor) => {
      if (await advisor.isDemo(businessId)) return;
      await input.assertAccess(businessId, actor);
    },
    visible: async (businessIds, actor) => {
      const demo = await Promise.all(businessIds.map((id) => advisor.isDemo(id)));
      const stored = await input.visibleTo(businessIds.filter((_, i) => !demo[i]), actor);
      return [...businessIds.filter((_, i) => demo[i]), ...stored];
    },
  },
  checkDb: connectDb,
  upstreamStatus: () => openMeteo.status(),
});

const server = app.listen(env.PORT, () => {
  logger.info(`API listening on http://localhost:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    refresh.stop();
    advisor.stop();
    clearInterval(inputRetry);
    server.close(() => {
      redis.disconnect();
      // The last lines are written before the database connection goes
      void dbLogs
        .stop()
        .then(disconnectDb)
        .then(() => process.exit(0));
    });
  });
}
