import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createTestAdvisor } from "../services/advisor/testing/fixtures.js";
import { BANK, OWNER, fakeAuth, signedIn } from "../services/auth/testing/fake-auth.js";

// Who may call what. Add every new route here: a route missing from these
// lists is a route nobody has decided the access rule for.
type Method = "get" | "post" | "put" | "patch";
type Route = [Method, string];

const STUB = {} as never;
const ID = "11111111-1111-4111-8111-111111111111";

function app() {
  const { advisor } = createTestAdvisor();
  return createApp({
    auth: { service: fakeAuth() },
    climate: STUB,
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    alerts: STUB,
    advisor: { service: advisor, devRoutes: true, assertAccess: () => Promise.resolve() },
    input: { service: { logRequest: () => undefined } as never, options: { seed: { enabled: true, file: "unused" } } },
    finance: { service: STUB, assertAccess: () => Promise.resolve() },
    evaluator: { service: STUB, assertAccess: () => Promise.resolve() },
    ml: { client: STUB },
  });
}

// Routes that need a signed-in user of any role
const SIGNED_IN_ONLY: Route[] = [
  ["post", "/climate/profile"],
  ["get", "/climate/events"],
  ["get", "/climate/cell/c1"],
  ["get", "/auth/me"],
  ["get", "/finance/demo"],
  ["post", "/finance/evaluate-location"],
  ["get", "/finance/business/b1/profile"],
  ["get", "/evaluate/business/b1"],
  ["get", "/ml/status"],
  ["post", "/ml/alerts/calibrate"],
  ["post", "/ml/anomaly"],
  ["post", "/ml/climate-cashflow"],
  ["get", "/advisor/businesses"],
  ["post", "/advisor/chat"],
  ["post", "/advisor/damage-report"],
  ["get", "/advisor/conversations/b1"],
  ["get", "/advisor/loans/LN-0101/state"],
  ["post", "/businesses"],
  ["get", "/businesses/b1"],
  ["patch", "/businesses/b1"],
  ["put", "/businesses/b1/locations"],
  ["put", "/businesses/b1/suppliers"],
  ["post", "/businesses/b1/snapshots"],
  ["get", "/businesses/b1/snapshots"],
];

// Routes only a bank officer may call: an owner is refused with 403
const BANK_ONLY: Route[] = [
  ["get", "/alerts"],
  ["post", "/seed/smes"],
  ["post", `/advisor/proposals/${ID}/decision`],
  ["post", "/advisor/loans/LN-0101/disburse"],
  ["post", "/advisor/loans/LN-0101/close-recovery"],
  ["post", "/advisor/dev/fake-alert"],
  ["post", "/advisor/dev/verify-alert"],
  ["post", "/advisor/dev/sweep-alerts"],
];

const OPEN: Route[] = [
  ["get", "/health"],
  ["get", "/auth/config"],
];

const call = (agent: { [m in Method]: (path: string) => request.Test }, [method, path]: Route) =>
  agent[method](path).set("Idempotency-Key", "matrix-test-key").send({});

describe("access matrix", () => {
  it.each([...SIGNED_IN_ONLY, ...BANK_ONLY])("refuses %s %s when nobody is signed in", async (method, path) => {
    const res = await call(request(app()), [method, path]);
    expect(res.status).toBe(401);
  });

  it.each(BANK_ONLY)("keeps %s %s from business owners", async (method, path) => {
    const res = await call(signedIn(app(), OWNER), [method, path]);
    expect(res.status).toBe(403);
  });

  it.each(BANK_ONLY)("lets a bank officer past the role check on %s %s", async (method, path) => {
    const res = await call(signedIn(app(), BANK), [method, path]);
    // Whatever the handler then says, it is not a refusal of the role
    expect([401, 403]).not.toContain(res.status);
  });

  it.each(OPEN)("leaves %s %s open", async (method, path) => {
    const res = await call(request(app()), [method, path]);
    expect(res.status).toBe(200);
  });
});