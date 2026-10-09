import request from "supertest";
import { describe, expect, it } from "vitest";
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
