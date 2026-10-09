import { createApp } from "./app.js";
import { connectDb, disconnectDb, prisma } from "./config/db.js";
import { env } from "./config/env.js";
import { startClimateRefresh } from "./jobs/climate-refresh.js";
import { createRedis } from "./config/redis.js";
import { createRedisCache } from "./services/cache/cache.js";
import { createOpenAiAgent } from "./services/climate/agent.js";
import { createOpenMeteoClient } from "./services/climate/open-meteo.js";
import { createClimateService } from "./services/climate/profile.service.js";
import { createPrismaIdempotencyStore } from "./services/idempotency/prisma-store.js";

await connectDb();

const redis = createRedis();
const openMeteo = createOpenMeteoClient();
const idempotencyStore = createPrismaIdempotencyStore(prisma);
await idempotencyStore.purgeExpired();

const agent =
  env.OPENAI_API_KEY && env.CLIMATE_AGENT_ENABLED === "true"
    ? createOpenAiAgent({ apiKey: env.OPENAI_API_KEY, model: env.CLIMATE_AGENT_MODEL })
    : undefined;
console.log(
  agent ? `Climate agent: ${agent.version}` : "Climate agent: off (rule-based screening and scores)",
);

const climate = createClimateService({ prisma, openMeteo, cache: createRedisCache(redis), agent });
const refresh = startClimateRefresh(climate);

const app = createApp({
  idempotency: idempotencyStore,
  climate,
  checkDb: connectDb,
  upstreamStatus: () => openMeteo.status(),
});

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    refresh.stop();
    server.close(() => {
      redis.disconnect();
      void disconnectDb().then(() => process.exit(0));
    });
  });
}
