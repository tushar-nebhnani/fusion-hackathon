import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../app.js";
import { memoryAuditRecorder } from "../services/audit/testing/memory-recorder.js";
import { BANK, OWNER, fakeAuth, signedIn } from "../services/auth/testing/fake-auth.js";

function setup(overrides: Partial<AppDeps> = {}) {
  const audit = memoryAuditRecorder();
  const app = createApp({
    auth: { service: fakeAuth() },
    audit,
    climate: {
      getProfile: () => Promise.resolve({ grade: "C" } as never),
      getCell: () => Promise.reject(new Error("not used")),
    },
    alerts: { list: () => Promise.resolve({ alerts: [] }) },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    ...overrides,
  });
  return { app, audit };
}

describe("audit trail", () => {
  it("gives every answer a request id of its own", async () => {
    const { app } = setup();

    const first = await request(app).get("/health");
    const second = await request(app).get("/nowhere");

    expect(first.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });

  it("ignores a request id sent by the client", async () => {
    const { app } = setup();

    const res = await request(app).get("/health").set("X-Request-Id", "chosen-by-the-client");

    expect(res.headers["x-request-id"]).not.toBe("chosen-by-the-client");
  });

  it("records a write with who made it, and nothing of what was sent", async () => {
    const { app, audit } = setup();

    const res = await signedIn(app).post("/climate/profile").send({ lat: 19.076, lon: 72.8777 });

    expect(res.status).toBe(200);
    expect(audit.events).toEqual([
      {
        requestId: res.headers["x-request-id"],
        actorId: OWNER.id,
        actorRole: "owner",
        action: "POST /climate/profile",
        targetType: null,
        targetId: null,
        outcome: "success",
        status: 200,
        reason: null,
      },
    ]);
    expect(JSON.stringify(audit.events)).not.toContain("19.076");
  });

  it("records a request that was refused for lack of a session or of the role", async () => {
    const { app, audit } = setup();

    await request(app).get("/auth/me");
    await signedIn(app).get("/alerts");
    await signedIn(app, BANK).get("/alerts");

    expect(audit.events).toMatchObject([
      { actorId: null, action: "GET /auth/me", outcome: "denied", status: 401, reason: "UNAUTHORIZED" },
      { actorId: OWNER.id, actorRole: "owner", action: "GET /alerts", outcome: "denied", status: 403, reason: "FORBIDDEN" },
    ]);
  });

  it("records a write that failed, with the error code as the reason", async () => {
    const { app, audit } = setup();

    await signedIn(app).post("/climate/profile").send({ lat: "north", lon: 72.8 });

    expect(audit.events).toMatchObject([
      { action: "POST /climate/profile", outcome: "failure", status: 400, reason: "INVALID_COORDINATES" },
    ]);
  });

  it("says when a write was a replay of an earlier one", async () => {
    const { app, audit } = setup();
    const send = () =>
      signedIn(app).post("/climate/profile").set("Idempotency-Key", "k-1").send({ lat: 19.076, lon: 72.8777 });

    await send();
    await send();

    expect(audit.events.map((event) => event.reason)).toEqual([null, "IDEMPOTENT_REPLAY"]);
  });

  it("does not record plain reads or rate-limited requests", async () => {
    const { app, audit } = setup({ rateLimit: 2 });

    await request(app).get("/health");
    await signedIn(app).get("/auth/me");
    const limited = await signedIn(app).post("/climate/profile").send({ lat: 19.076, lon: 72.8777 });

    expect(limited.status).toBe(429);
    expect(audit.events).toEqual([]);
  });

  it("keeps the query string out of a refusal recorded before a route matched", async () => {
    const { app, audit } = setup();

    await request(app).get("/climate/events?lat=19.076&lon=72.8777");

    expect(audit.events).toMatchObject([{ action: "GET /climate/events", outcome: "denied", status: 401 }]);
  });
});
