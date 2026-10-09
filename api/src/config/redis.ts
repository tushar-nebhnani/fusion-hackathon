import { Redis } from "ioredis";
import { env } from "./env.js";

// Commands fail fast instead of queueing while Redis is unreachable, so the
// cache degrades to misses rather than stalling requests.
export function createRedis(url = env.REDIS_URL, logger: Pick<Console, "warn"> = console): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });

  // ioredis emits an error on every reconnect attempt; log once per outage
  let down = false;
  redis.on("error", (error: Error) => {
    if (!down) logger.warn("redis: connection lost", error.message);
    down = true;
  });
  redis.on("ready", () => {
    down = false;
  });
  return redis;
}
