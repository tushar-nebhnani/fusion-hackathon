import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { BANK, OWNER, fakeAuth, signedIn } from "../services/auth/testing/fake-auth.js";
import type { AlertReader } from "../services/alerts/reader.js";

function setup(rateLimit = 1000) {
  const list = vi.fn<AlertReader["list"]>(() => Promise.resolve({ alerts: [] }));
  const app = createApp({
    auth: { service: fakeAuth() },
    climate: {
      getProfile: () => Promise.reject(new Error("not used")),
      getCell: () => Promise.reject(new Error("not used")),
    },
    alerts: { list },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    rateLimit,
  });
  return { app, list };
}

describe("GET /alerts", () => {
  it("lists alerts with a default limit", async () => {
    const { app, list } = setup();
    const res = await signedIn(app, BANK).get("/alerts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ alerts: [] });
    expect(list).toHaveBeenCalledWith({ limit: 50, businessId: undefined, status: undefined });
  });

  it("passes filters through", async () => {
    const { app, list } = setup();
    await signedIn(app, BANK).get("/alerts?limit=5&business_id=SME-0142&status=sent");

    expect(list).toHaveBeenCalledWith({ limit: 5, businessId: "SME-0142", status: "sent" });
  });

  it("rejects an invalid filter with the standard error shape", async () => {
    const { app, list } = setup();

    for (const query of ["limit=0", "limit=101", "limit=many", "status=lost"]) {
      const res = await signedIn(app, BANK).get(`/alerts?${query}`);
      expect(res.status, query).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("is rate limited like every other route", async () => {
    const { app } = setup(2);
    await signedIn(app, BANK).get("/alerts");
    await signedIn(app, BANK).get("/alerts");

    const res = await signedIn(app, BANK).get("/alerts");
    expect(res.status).toBe(429);
    expect((res.body as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  it("is for bank officers only", async () => {
    const { app, list } = setup();

    const anonymous = await request(app).get("/alerts");
    const owner = await signedIn(app, OWNER).get("/alerts");

    expect(anonymous.status).toBe(401);
    expect(owner.status).toBe(403);
    expect((owner.body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(list).not.toHaveBeenCalled();
  });

  it("is not mounted when the app is given no alert reader", async () => {
    const app = createApp({
      auth: { service: fakeAuth() },
      climate: {
        getProfile: () => Promise.reject(new Error("not used")),
        getCell: () => Promise.reject(new Error("not used")),
      },
      checkDb: () => Promise.resolve(),
      upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    });
    expect((await signedIn(app, BANK).get("/alerts")).status).toBe(404);
  });
});
