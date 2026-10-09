import { resolve } from "node:path";
import { disconnectDb, prisma } from "../../../config/db.js";
import { env } from "../../../config/env.js";
import { createRedis } from "../../../config/redis.js";
import { loadAlertsConfig } from "../../alerts/config.js";
import { createEnqueue } from "../../alerts/enqueue.js";
import { createRedisCache } from "../../cache/cache.js";
import { createOpenAiAgent } from "../agent.js";
import { createOpenMeteoClient } from "../open-meteo.js";
import { createClimateService } from "../profile.service.js";
import { createRepository } from "../repository.js";
import { systemClock } from "./adapters/clock.js";
import { createConsoleAlertSink } from "./adapters/consoleAlertSink.js";
import { consoleRunLogger } from "./adapters/consoleRunLogger.js";
import { createJsonLocationSource } from "./adapters/jsonLocationSource.js";
import { createAgentReviewer } from "./agentReview.js";
import { loadMonitorConfig } from "./config.js";
import type { AlertSink } from "./ports.js";
import { createMonitorRepo } from "./repo.js";
import { createMonitor } from "./tick.js";

// Wires the monitor to the climate unit and to the three ports. This is the
// only file that knows which adapter stands behind each port; README.md says
// what to change here when the loans DB and the logs system exist.
export function buildMonitor() {
  const config = loadMonitorConfig();
  const logger = consoleRunLogger;
  const redis = createRedis();
  const openMeteo = createOpenMeteoClient();

  // The same pipeline, database and cache as the API, in this process. No
  // agent is passed in: a check must stay fast, and the monitor asks the
  // agent itself, on its own schedule.
  const climate = createClimateService({ prisma, openMeteo, cache: createRedisCache(redis) });

  const agent =
    config.agentEnabled && env.OPENAI_API_KEY
      ? createOpenAiAgent({ apiKey: env.OPENAI_API_KEY, model: env.CLIMATE_AGENT_MODEL })
      : undefined;

  // The alert system's own enqueue(): one INSERT into its outbox
  const sink: AlertSink =
    config.alertSink === "console"
      ? createConsoleAlertSink()
      : { enqueue: createEnqueue({ prisma, config: loadAlertsConfig() }) };

  const repo = createMonitorRepo(prisma);
  const monitor = createMonitor({
    config,
    climate,
    source: createJsonLocationSource(resolve(config.locationsFile), logger),
    sink,
    logger,
    clock: systemClock,
    repo,
    review: createAgentReviewer({ enabled: config.agentEnabled, agent, settings: config, logger }),
  });

  return {
    config,
    logger,
    monitor,
    // What the verification job needs on top: the monitor's tables, the
    // climate unit's stored screening and its historical fetchers
    repo,
    relevance: createRepository(prisma),
    openMeteo,
    clock: systemClock,
    agentVersion: agent?.version ?? null,
    async close(): Promise<void> {
      redis.disconnect();
      await disconnectDb();
    },
  };
}
