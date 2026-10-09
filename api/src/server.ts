import { createApp } from "./app.js";
import { CLIMATE } from "./config/climate.js";
import { connectDb, disconnectDb, prisma } from "./config/db.js";
import { env } from "./config/env.js";
import { startClimateRefresh } from "./jobs/climate-refresh.js";
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
import { createPrismaIdempotencyStore } from "./services/idempotency/prisma-store.js";
import { createOpenAiClassifier } from "./services/input/classifier/openai.js";
import { INPUT, loadInputEnv } from "./services/input/config.js";
import { createInputService } from "./services/input/service.js";

await connectDb();

const redis = createRedis();
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

console.log(
  authEnv.googleClientId
    ? "Sign in with Google: on"
    : "Sign in with Google: off (set GOOGLE_CLIENT_ID; protected routes answer 401 until then)",
);

if (!authEnv.rolesEnforced) {
  console.warn("Roles: off (AUTH_ROLES_ENFORCED=false). Every signed-in user has bank access");
}

const agent =
  env.OPENAI_API_KEY && env.CLIMATE_AGENT_ENABLED === "true"
    ? createOpenAiAgent({ apiKey: env.OPENAI_API_KEY, model: env.CLIMATE_AGENT_MODEL })
    : undefined;
console.log(
  agent ? `Climate agent: ${agent.version}` : "Climate agent: off (rule-based screening and scores)",
);

const climate = createClimateService({ prisma, openMeteo, cache: createRedisCache(redis), agent });
const refresh = startClimateRefresh(climate);

const inputEnv = loadInputEnv();
const classifier =
  env.OPENAI_API_KEY && inputEnv.classifierEnabled
    ? createOpenAiClassifier({ apiKey: env.OPENAI_API_KEY, model: inputEnv.classifierModel })
    : undefined;
console.log(
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
const scorer = chooseScorer(financeEnv);
console.log(`Finance scorer: ${scorer.name}`);
const finance = createFinanceService({ prisma, businesses: input, climate, scorer });
// Checks the climate and finance answers together; the advisor reads both only through it
const evaluator = createEvaluatorService({
  climate,
  businesses: input,
  finance,
  store: createPrismaEvaluationStore(prisma),
});
const advisor = createAdvisorFromEnv({ prisma, evaluator });
const inputRetry = setInterval(() => {
  input.retryPending().catch((error: unknown) => {
    console.error("input: retry of pending work failed", error);
  });
}, INPUT.retryMinutes * 60_000);

const app = createApp({
  auth: {
    service: auth,
    allowedOrigins: authEnv.allowedOrigins,
    cookie: { sameSite: authEnv.cookieSameSite, secure: authEnv.cookieSecure },
  },
  idempotency: idempotencyStore,
  audit: createPrismaAuditRecorder(prisma),
  trustProxy: env.TRUST_PROXY,
  climate,
  input: {
    service: input,
    options: { seed: { enabled: env.NODE_ENV !== "production", file: inputEnv.seedFile } },
  },
  finance: { service: finance, assertAccess: (id, actor) => input.assertAccess(id, actor) },
  evaluator: { service: evaluator, assertAccess: (id, actor) => input.assertAccess(id, actor) },
  alerts: createAlertReader(prisma),
  advisor: {
    service: advisor.advisor,
    devRoutes: advisor.config.enableDevRoutes,
    enqueue: createEnqueue({ prisma, config: loadAlertsConfig() }),
    // The input service's ownership and sharing rule. The smes.json demo
    // businesses (never in production) stay open to every signed-in user.
    assertAccess: async (businessId, actor) => {
      if (await advisor.isDemo(businessId)) return;
      await input.assertAccess(businessId, actor);
    },
  },
  checkDb: connectDb,
  upstreamStatus: () => openMeteo.status(),
});

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    refresh.stop();
    advisor.stop();
    clearInterval(inputRetry);
    server.close(() => {
      redis.disconnect();
      void disconnectDb().then(() => process.exit(0));
    });
  });
}
