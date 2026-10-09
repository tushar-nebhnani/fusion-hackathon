import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from "express-rate-limit";
import type { Redis } from "ioredis";

// One counter per client and window, with the window's expiry set by the
// first hit. Returns the count and the milliseconds left.
const HIT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }`;

// Gives each limiter its own store, named after what it limits
export type RateLimitStoreFactory = (name: string) => Store;

// Rate limit counters in Redis, so they survive a restart and are shared by
// every API instance. While Redis is unreachable a limiter counts in this
// process instead: it is then per instance again, but never switched off.
export function createRedisRateLimitStores(
  redis: Redis,
  options: { prefix?: string; logger?: Pick<Console, "warn"> } = {},
): RateLimitStoreFactory {
  const prefix = options.prefix ?? "fusion:rl:";
  const logger = options.logger ?? console;

  return (name) => {
    const fallback = new MemoryStore();
    let windowMs = 60_000;
    let down = false;
    const key = (client: string) => `${prefix}${name}:${client}`;

    async function attempt<T>(action: () => Promise<T>, otherwise: () => Promise<T> | T): Promise<T> {
      try {
        const result = await action();
        down = false;
        return result;
      } catch (error) {
        // Once per outage, like the Redis connection's own warning
        if (!down) {
          logger.warn(
            `rate limit: Redis is unavailable, "${name}" is counting in this process,`,
            error instanceof Error ? error.message : error,
          );
        }
        down = true;
        return otherwise();
      }
    }

    return {
      // Counters are shared: express-rate-limit must not assume it holds them
      localKeys: false,
      prefix: key(""),

      init(limiter: Options) {
        windowMs = limiter.windowMs;
        fallback.init(limiter);
      },

      increment(client: string): Promise<ClientRateLimitInfo> {
        return attempt(
          async () => {
            const [hits, ttl] = (await redis.eval(HIT, 1, key(client), windowMs)) as [number, number];
            return { totalHits: hits, resetTime: new Date(Date.now() + ttl) };
          },
          () => fallback.increment(client),
        );
      },

      decrement(client: string): Promise<void> {
        return attempt(
          async () => {
            await redis.decr(key(client));
          },
          () => fallback.decrement(client),
        );
      },

      resetKey(client: string): Promise<void> {
        return attempt(
          async () => {
            await redis.del(key(client));
          },
          () => fallback.resetKey(client),
        );
      },
    };
  };
}
