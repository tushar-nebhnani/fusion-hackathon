import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.js";

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    climate: {
      getProfile: () => Promise.reject(new Error("not used")),
      getCell: () => Promise.reject(new Error("not used")),
    },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    ...overrides,
  });
}

describe("GET /health", () => {
  it("reports service, database and upstream status", async () => {
    const res = await request(app()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      db: "up",
      upstream: { open_meteo: { state: "unknown", checked_at: null } },
    });
  });

  it("is degraded, but still 200, when Open-Meteo is down", async () => {
    const res = await request(
      app({ upstreamStatus: () => ({ state: "down", checked_at: "2026-10-09T06:00:00.000Z" }) }),
    ).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "degraded", db: "up" });
  });

  it("returns 503 without leaking details when the database is down", async () => {
    const res = await request(
      app({ checkDb: () => Promise.reject(new Error("password authentication failed")) }),
    ).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "down", db: "down" });
    expect(JSON.stringify(res.body)).not.toContain("password");
  });
});

describe("GET /demo", () => {
  it("serves the demo page", async () => {
    const res = await request(app()).get("/demo/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Climate risk profile");
  });

  it("answers an unknown demo file with the standard 404", async () => {
    const res = await request(app()).get("/demo/nope.js");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});

describe("rate limiting", () => {
  it("limits every endpoint, including /health and unknown routes", async () => {
    const limited = app({ rateLimit: 2 });

    await request(limited).get("/health");
    await request(limited).get("/nope");
    const res = await request(limited).get("/health");

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(res.headers).toHaveProperty("ratelimit");
  });

  it("limits the demo page too", async () => {
    const limited = app({ rateLimit: 1 });

    await request(limited).get("/demo/");
    const res = await request(limited).get("/demo/");

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("idempotency", () => {
  it("replays POST /climate/profile for a repeated Idempotency-Key", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const server = app({ climate: { getProfile, getCell: () => Promise.reject(new Error("no")) } });
    const send = () =>
      request(server)
        .post("/climate/profile")
        .set("Idempotency-Key", "abc-123")
        .send({ lat: 26.1445, lon: 91.7362 });

    const first = await send();
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it("does not store a rate-limited response against the key", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const server = app({
      climate: { getProfile, getCell: () => Promise.reject(new Error("no")) },
      climateRateLimit: 1,
    });
    await request(server).post("/climate/profile").send({ lat: 26.1445, lon: 91.7362 });

    const limited = await request(server)
      .post("/climate/profile")
      .set("Idempotency-Key", "abc-123")
      .send({ lat: 26.1445, lon: 91.7362 });

    expect(limited.status).toBe(429);
    expect(limited.headers).not.toHaveProperty("idempotency-replayed");
  });
});

describe("app", () => {
  it("returns the standard 404 error for unknown routes", async () => {
    const res = await request(app()).get("/nope");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("does not advertise the framework", async () => {
    const res = await request(app()).get("/health");
    expect(res.headers).not.toHaveProperty("x-powered-by");
  });

  it("rejects request bodies over 10kb", async () => {
    const res = await request(app())
      .post("/climate/profile")
      .send({ lat: 26.1, lon: 91.7, padding: "x".repeat(20_000) });

    expect(res.status).toBe(413);
  });
});
