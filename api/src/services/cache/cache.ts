import type { Redis } from "ioredis";

// JSON cache with a time to live. Implementations never throw: a failed read
// is a miss and a failed write is dropped, so the cache can be down without
// failing a request.
export interface Cache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Used when no cache is wired in; every read misses
export const noopCache: Cache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  del: () => Promise.resolve(),
};

export function createRedisCache(
  redis: Redis,
  options: { prefix?: string; logger?: Pick<Console, "warn"> } = {},
): Cache {
  const prefix = options.prefix ?? "fusion:";
  const logger = options.logger ?? console;

  async function attempt<T>(label: string, fallback: T, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      logger.warn(`cache: ${label} failed`, error);
      return fallback;
    }
  }

  return {
    get: (key) =>
      attempt<unknown>("get", null, async () => {
        const raw = await redis.get(prefix + key);
        return raw === null ? null : (JSON.parse(raw) as unknown);
      }),
    set: (key, value, ttlMs) =>
      attempt("set", undefined, async () => {
        if (ttlMs < 1) return;
        await redis.set(prefix + key, JSON.stringify(value), "PX", Math.ceil(ttlMs));
      }),
    del: (key) =>
      attempt("del", undefined, async () => {
        await redis.del(prefix + key);
      }),
  };
}
