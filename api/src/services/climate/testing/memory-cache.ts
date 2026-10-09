import type { Cache } from "../../cache/cache.js";

// In-process cache for tests. Entries never expire by themselves, which
// mirrors a Redis key whose TTL has not run out yet under a faked clock.
export function memoryCache(): Cache & { store: Map<string, { value: string; ttlMs: number }> } {
  const store = new Map<string, { value: string; ttlMs: number }>();
  return {
    store,
    get(key) {
      const entry = store.get(key);
      return Promise.resolve(entry ? (JSON.parse(entry.value) as unknown) : null);
    },
    set(key, value, ttlMs) {
      if (ttlMs >= 1) store.set(key, { value: JSON.stringify(value), ttlMs });
      return Promise.resolve();
    },
    del(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}
