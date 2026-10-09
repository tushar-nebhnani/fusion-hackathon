import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRedis } from "../../config/redis.js";
import { createRedisCache } from "./cache.js";

// Integration tests against the real Redis, in the test database
const redis = createRedis();
const silent = { warn: vi.fn() };
const cache = createRedisCache(redis, { prefix: "cache-test:", logger: silent });

beforeAll(async () => {
  await once(redis, "ready");
});

beforeEach(async () => {
  const keys = await redis.keys("cache-test:*");
  if (keys.length > 0) await redis.del(...keys);
  silent.warn.mockClear();
});

afterAll(() => {
  redis.disconnect();
});

describe("redis cache", () => {
  it("runs against the test database, never the dev one", () => {
    expect(redis.options.db).toBe(1);
  });

  it("round-trips JSON values", async () => {
    await cache.set("a", { n: 1, list: ["x"], at: new Date(0) }, 60_000);

    expect(await cache.get("a")).toEqual({ n: 1, list: ["x"], at: "1970-01-01T00:00:00.000Z" });
  });

  it("returns null for a missing key", async () => {
    expect(await cache.get("nope")).toBeNull();
  });

  it("stores the key with its time to live", async () => {
    await cache.set("a", 1, 60_000);

    const ttl = await redis.pttl("cache-test:a");
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("does not store entries that are already expired", async () => {
    await cache.set("a", 1, 0);
    expect(await cache.get("a")).toBeNull();
  });

  it("deletes a key", async () => {
    await cache.set("a", 1, 60_000);
    await cache.del("a");
    expect(await cache.get("a")).toBeNull();
  });

  it("treats corrupt entries as a miss", async () => {
    await redis.set("cache-test:a", "{not json");
    expect(await cache.get("a")).toBeNull();
    expect(silent.warn).toHaveBeenCalled();
  });

  it("degrades to misses, without throwing, when Redis is unreachable", async () => {
    const dead = createRedis("redis://127.0.0.1:1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const offline = createRedisCache(dead, { logger: silent });

    await expect(offline.set("a", 1, 60_000)).resolves.toBeUndefined();
    await expect(offline.get("a")).resolves.toBeNull();
    await expect(offline.del("a")).resolves.toBeUndefined();

    dead.disconnect();
    warn.mockRestore();
  });
});
