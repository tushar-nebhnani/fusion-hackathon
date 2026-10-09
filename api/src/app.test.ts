import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "./app.js";
import { OTHER_OWNER, OWNER, fakeAuth, signedIn } from "./services/auth/testing/fake-auth.js";

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    auth: { service: fakeAuth() },
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
});

describe("rate limiting per user", () => {
  it("counts a route's limit per signed-in user, not per address", async () => {
    const server = app({ climateRateLimit: 1 });
    const call = (user: typeof OWNER) => signedIn(server, user).post("/climate/profile").send({});

    expect((await call(OWNER)).status).toBe(400);
    expect((await call(OWNER)).status).toBe(429);
    // Same address, another account: its own count
    expect((await call(OTHER_OWNER)).status).toBe(400);
  });
});

describe("idempotency", () => {
  it("replays POST /climate/profile for a repeated Idempotency-Key", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const server = app({ climate: { getProfile, getCell: () => Promise.reject(new Error("no")) } });
    const send = () =>
      signedIn(server)
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
    await signedIn(server).post("/climate/profile").send({ lat: 26.1445, lon: 91.7362 });

    const limited = await signedIn(server)
      .post("/climate/profile")
      .set("Idempotency-Key", "abc-123")
      .send({ lat: 26.1445, lon: 91.7362 });

    expect(limited.status).toBe(429);
    expect(limited.headers).not.toHaveProperty("idempotency-replayed");
  });
});

describe("authentication", () => {
  const point = { lat: 26.1445, lon: 91.7362 };

  it("answers 401 on protected routes without a session, and runs nothing", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const list = vi.fn(() => Promise.resolve({ alerts: [] }));
    const server = app({ climate: { getProfile, getCell: getProfile }, alerts: { list } });

    const results = await Promise.all([
      request(server).post("/climate/profile").send(point),
      request(server).get("/climate/events?lat=26.1&lon=91.7"),
      request(server).get("/climate/cell/0.1:26.1:91.7"),
      request(server).get("/alerts"),
      request(server).post("/climate/profile").set("Cookie", "fusion_session=forged").send(point),
    ]);

    for (const res of results) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    }
    expect(getProfile).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses to switch sign-in off in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => app({ auth: { service: fakeAuth(), devUser: OWNER } })).toThrow(/production/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(() => app({ auth: { service: fakeAuth(), devUser: OWNER } })).not.toThrow();
  });

  it("leaves /health and /auth/config open", async () => {
    const server = app();

    expect((await request(server).get("/health")).status).toBe(200);
    expect((await request(server).get("/auth/config")).body).toEqual({
      google_client_id: "test-client-id",
    });
  });

  it("does not replay one user's response to another user or to nobody", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const server = app({ climate: { getProfile, getCell: () => Promise.reject(new Error("no")) } });
    const send = (client: ReturnType<typeof request>) =>
      client.post("/climate/profile").set("Idempotency-Key", "shared-key").send(point);

    const mine = await send(signedIn(server, OWNER));
    const theirs = await send(signedIn(server, OTHER_OWNER));
    const anonymous = await send(request(server));

    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    expect(theirs.headers).not.toHaveProperty("idempotency-replayed");
    expect(anonymous.status).toBe(401);
    expect(getProfile).toHaveBeenCalledTimes(2);
  });
});

describe("cross-origin requests", () => {
  const WEB = "http://localhost:3000";
  const server = () => app({ auth: { service: fakeAuth(), allowedOrigins: [WEB] } });

  it("lets an allowed frontend send the session cookie", async () => {
    const preflight = await request(server())
      .options("/climate/profile")
      .set({ Origin: WEB, "Access-Control-Request-Method": "POST" });
    const res = await request(server()).get("/health").set("Origin", WEB);

    expect(preflight.status).toBe(204);
    expect(preflight.headers).toMatchObject({
      "access-control-allow-origin": WEB,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Idempotency-Key",
    });
    expect(res.headers["access-control-allow-origin"]).toBe(WEB);
  });

  it("refuses a write from any other website, even with a valid session", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const evil = app({ climate: { getProfile, getCell: getProfile } });

    const res = await signedIn(evil)
      .post("/climate/profile")
      .set("Origin", "https://evil.example")
      .send({ lat: 26.1445, lon: 91.7362 });
    const read = await request(evil).get("/health").set("Origin", "https://evil.example");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    expect(getProfile).not.toHaveBeenCalled();
    expect(read.status).toBe(200);
    expect(read.headers).not.toHaveProperty("access-control-allow-origin");
  });

  it("allows any origin when the list is \"*\"", async () => {
    const getProfile = vi.fn(() => Promise.resolve({ grade: "C" } as never));
    const open = app({ auth: { service: fakeAuth(), allowedOrigins: ["*"] }, climate: { getProfile, getCell: getProfile } });

    const res = await signedIn(open)
      .post("/climate/profile")
      .set("Origin", "http://127.0.0.1:5500")
      .send({ lat: 26.1445, lon: 91.7362 });

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5500");
  });

  it("accepts a write from a page the API serves itself", async () => {
    const server = app({ climate: { getProfile: () => Promise.resolve({ grade: "C" } as never), getCell: () => Promise.reject(new Error("no")) } });

    const res = await signedIn(server)
      .post("/climate/profile")
      .set({ Host: "localhost:4000", Origin: "http://localhost:4000" })
      .send({ lat: 26.1445, lon: 91.7362 });

    expect(res.status).toBe(200);
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

  it("sends the security headers on every answer, errors included", async () => {
    for (const path of ["/health", "/climate/cell/x", "/nowhere"]) {
      const res = await request(app()).get(path);

      expect(res.headers).toMatchObject({
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      });
      expect(res.headers).not.toHaveProperty("strict-transport-security");
    }
  });

  it("adds HSTS only when the session cookie is Secure", async () => {
    const res = await request(
      app({ auth: { service: fakeAuth(), cookie: { sameSite: "none", secure: true } } }),
    ).get("/health");

    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("rejects request bodies over 10kb", async () => {
    const res = await request(app())
      .post("/climate/profile")
      .send({ lat: 26.1, lon: 91.7, padding: "x".repeat(20_000) });

    expect(res.status).toBe(413);
  });
});
