import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, prisma } from "../../config/db.js";
import { createPrismaIdempotencyStore } from "./prisma-store.js";

// Integration tests against the real test database
const NOW = new Date("2026-10-09T06:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);
const store = createPrismaIdempotencyStore(prisma);
const claim = (fingerprint = "f1", now = NOW) =>
  store.begin({ scope: "POST /x", key: "k1", fingerprint, now, lockUntil: later(60_000) });

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE idempotency_keys`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("prisma idempotency store", () => {
  it("lets exactly one of several simultaneous requests start", async () => {
    const results = await Promise.all([claim(), claim(), claim(), claim()]);

    expect(results.filter((r) => r.kind === "started")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "in_progress")).toHaveLength(3);
  });

  it("replays a completed response", async () => {
    await claim();
    await store.complete({
      scope: "POST /x",
      key: "k1",
      status: 201,
      body: '{"id":1}',
      expiresAt: later(3_600_000),
    });

    expect(await claim()).toEqual({ kind: "replay", status: 201, body: '{"id":1}' });
  });

  it("reports a mismatch for a different fingerprint", async () => {
    await claim("f1");
    expect(await claim("f2")).toEqual({ kind: "mismatch" });
  });

  it("frees the key on release", async () => {
    await claim();
    await store.release("POST /x", "k1");
    expect(await claim()).toEqual({ kind: "started" });
  });

  it("lets an expired key be taken over, even by a different request", async () => {
    await claim("f1");
    expect(await claim("f2", later(60_001))).toEqual({ kind: "started" });
  });

  it("keeps the same key separate per scope", async () => {
    await claim();
    const other = await store.begin({
      scope: "POST /y",
      key: "k1",
      fingerprint: "f1",
      now: NOW,
      lockUntil: later(60_000),
    });
    expect(other).toEqual({ kind: "started" });
  });

  it("purges only expired rows", async () => {
    await claim();
    await store.begin({ scope: "POST /y", key: "k2", fingerprint: "f", now: NOW, lockUntil: later(10) });

    expect(await store.purgeExpired(later(1_000))).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});
