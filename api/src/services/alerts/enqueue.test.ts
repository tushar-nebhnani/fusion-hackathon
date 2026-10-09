import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { loadAlertsConfig } from "./config.js";
import { createEnqueue } from "./enqueue.js";
import type { AlertEvent } from "./types.js";
import { withTimeout } from "./withTimeout.js";

const NOW = new Date("2026-10-09T06:00:00Z");
const config = loadAlertsConfig({});
const logger = { warn: vi.fn(), error: vi.fn() };
const event: AlertEvent = {
  businessId: "SME-0142",
  hazard: "flood",
  severity: "WARNING",
  windowStart: "2026-10-12",
  windowEnd: "2026-10-14",
  evidence: "Heavy-rain tripwire crossed",
  sourceRunId: "mon-2026-10-09T15:45",
};

function setup(createMany: () => Promise<unknown>, overrides = config) {
  const insert = vi.fn(createMany);
  const prisma = { alertOutbox: { createMany: insert } } as unknown as PrismaClient;
  return { insert, enqueue: createEnqueue({ prisma, config: overrides, now: () => NOW, logger }) };
}

afterEach(() => {
  vi.useRealTimers();
  logger.warn.mockClear();
  logger.error.mockClear();
});

describe("enqueue", () => {
  it("writes one row per audience in a single insert", async () => {
    const { insert, enqueue } = setup(() => Promise.resolve({ count: 2 }));

    expect(await enqueue(event)).toBe(true);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          dedupeKey: "SME-0142:flood:WARNING:2026-10-12",
          audience: "owner",
          channel: "email",
          nextTryAt: NOW,
          payload: event,
        }),
        expect.objectContaining({ audience: "bank", channel: "email", nextTryAt: NOW }),
      ],
    });
  });

  it("resolves to false quickly, without rejecting, when the database is unavailable", async () => {
    const { enqueue } = setup(() => Promise.reject(new Error("Can't reach database server")));

    const started = performance.now();
    expect(await enqueue(event)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("gives up on a database that never answers", async () => {
    vi.useFakeTimers();
    const { enqueue } = setup(() => new Promise(() => undefined));

    const result = enqueue(event);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toBe(false);
  });

  it("does not throw when the database client itself throws", async () => {
    const { enqueue } = setup(() => {
      throw new Error("client is not connected");
    });
    expect(await enqueue(event)).toBe(false);
  });

  it("rejects an invalid event without touching the database", async () => {
    const { insert, enqueue } = setup(() => Promise.resolve({ count: 0 }));

    expect(await enqueue({ ...event, severity: "SEVERE" } as unknown as AlertEvent)).toBe(false);
    expect(await enqueue({ ...event, windowStart: "12 Oct" })).toBe(false);
    expect(await enqueue(undefined as unknown as AlertEvent)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("is a no-op when alerts are switched off", async () => {
    const { insert, enqueue } = setup(
      () => Promise.resolve({ count: 2 }),
      loadAlertsConfig({ ALERTS_ENABLED: "false" }),
    );

    expect(await enqueue(event)).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("withTimeout", () => {
  it("passes a result or an error through", async () => {
    expect(await withTimeout(Promise.resolve(7), 100, "x")).toBe(7);
    await expect(withTimeout(Promise.reject(new Error("boom")), 100, "x")).rejects.toThrow("boom");
  });

  it("rejects once the time is up", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 8000, "smtp send");
    const outcome = expect(pending).rejects.toThrow("smtp send timed out after 8000 ms");
    await vi.advanceTimersByTimeAsync(8000);
    await outcome;
  });
});
