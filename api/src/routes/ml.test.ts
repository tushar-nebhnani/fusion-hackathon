import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { fakeAuth, signedIn } from "../services/auth/testing/fake-auth.js";
import { createMlClient, loadMlEnv } from "../services/ml/index.js";

// The real Express app with a stand-in for the Python service: no network.
const STUB = {} as never;
const ML_URL = "http://ml.test";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function setup(reply: (call: Call) => Response | Promise<Response>, options: { url?: string | null; rateLimit?: number } = {}) {
  const calls: Call[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  const app = createApp({
    auth: { service: fakeAuth() },
    climate: STUB,
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    ml: {
      client: createMlClient({ url: options.url === undefined ? ML_URL : options.url, fetch: fakeFetch }),
      rateLimit: options.rateLimit,
    },
  });
  return { agent: signedIn(app), app, calls };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const ALERT = { hazard: "flood", lat: 19.08, lon: 72.88, date: "2026-07-20", precipitation_sum: [5, 80, 120] };
const SERIES = Array.from({ length: 24 }, (_, i) => 400_000 + i * 1000);
const BUSINESS = {
  lat: 26.14,
  lon: 91.74,
  monthly_revenue: 300_000,
  variable_cost_share: 0.6,
  fixed_costs: 75_000,
  emi: 25_000,
  starting_cash: 60_000,
  sector: "retail",
};
const SCORED = {
  scored: true,
  cell: "Guwahati",
  distance_km: 4.2,
  pd_without_climate: 0.001,
  pd_with_climate: 0.22,
  delta_pd_climate: 0.219,
  climate_premium_bps: 985.5,
  expected_annual_climate_loss: 132_000,
  climate_cfar95: 405_000,
  cash_reserve_target: 345_000,
  p_cash_short_30d: 0.05,
  p_cash_short_30d_without_climate: 0.0,
  loss_by_hazard: { river_flood: 90_000 },
  what_if: [{ condition: "install backup power", pd_with_climate: 0.22, pd_change: 0 }],
  paths: 20_000,
  hazards: { river_flood: { events_per_year: 2.86, mean_duration: 16.1 } },
  assumptions: ["Loss given default 45%."],
};

describe("POST /ml/alerts/calibrate", () => {
  it("forwards the alert and returns only the documented fields", async () => {
    const { agent, calls } = setup(() =>
      json({ p_event: 0.345, band: "high", model_version: "alert-cal-0.2.0", cell: "Mumbai", distance_km: 3.1, internal: "x" }),
    );
    const res = await agent.post("/ml/alerts/calibrate").send(ALERT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ p_event: 0.345, band: "high", model_version: "alert-cal-0.2.0", cell: "Mumbai", distance_km: 3.1 });
    expect(calls).toEqual([{ url: `${ML_URL}/alerts/calibrate`, method: "POST", body: ALERT }]);
  });

  it("refuses an unknown field or a bad value without calling the model", async () => {
    const { agent, calls } = setup(() => json({}));
    const typo = await agent.post("/ml/alerts/calibrate").send({ ...ALERT, precipitation: [1] });
    const hazard = await agent.post("/ml/alerts/calibrate").send({ ...ALERT, hazard: "heat" });
    const date = await agent.post("/ml/alerts/calibrate").send({ ...ALERT, date: "20 July" });
    expect([typo.status, hazard.status, date.status]).toEqual([400, 400, 400]);
    expect(typo.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(calls).toHaveLength(0);
  });
});

describe("POST /ml/anomaly", () => {
  it("returns the model's verdict", async () => {
    const verdict = { anomaly_score: 0.63, flagged: true, type: "systemic", months_flagged: 2, model_version: "cashflow-anomaly-0.1.0" };
    const { agent, calls } = setup(() => json(verdict));
    const res = await agent.post("/ml/anomaly").send({ monthly_revenue: SERIES, cell_anomalous_share: 0.5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(verdict);
    expect(calls[0]?.url).toBe(`${ML_URL}/anomaly`);
  });

  it("needs 13 months and late_payments of the same length", async () => {
    const { agent, calls } = setup(() => json({}));
    const short = await agent.post("/ml/anomaly").send({ monthly_revenue: SERIES.slice(0, 12) });
    const uneven = await agent.post("/ml/anomaly").send({ monthly_revenue: SERIES, late_payments: [true] });
    expect([short.status, uneven.status]).toEqual([400, 400]);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /ml/climate-cashflow", () => {
  it("returns the simulation for a business", async () => {
    const { agent, calls } = setup(() => json(SCORED));
    const res = await agent.post("/ml/climate-cashflow").send({ ...BUSINESS, pd_base: 0.04 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SCORED);
    expect(calls[0]).toMatchObject({ url: `${ML_URL}/risk/climate-cashflow`, body: { ...BUSINESS, pd_base: 0.04 } });
  });

  it("passes on a place the model cannot score", async () => {
    const { agent } = setup(() => json({ scored: false, reason: "no cell with measured hazards within 150 km" }));
    const res = await agent.post("/ml/climate-cashflow").send({ ...BUSINESS, lat: 0, lon: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scored: false });
  });

  it("needs a sector or a vulnerability, and an alert's hazard and probability together", async () => {
    const { agent, calls } = setup(() => json(SCORED));
    const { sector: _sector, ...bare } = BUSINESS;
    const noSector = await agent.post("/ml/climate-cashflow").send(bare);
    const halfAlert = await agent.post("/ml/climate-cashflow").send({ ...BUSINESS, alert_hazard: "storm" });
    const badShare = await agent.post("/ml/climate-cashflow").send({ ...bare, vulnerability: { heat: 1.4 } });
    const withVulnerability = await agent.post("/ml/climate-cashflow").send({ ...bare, vulnerability: { river_flood: 0.6 } });
    expect([noSector.status, halfAlert.status, badShare.status]).toEqual([400, 400, 400]);
    expect(withVulnerability.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("when the ML service is in trouble", () => {
  it("answers 503 when it cannot be reached or is not configured", async () => {
    const down = setup(() => Promise.reject(new TypeError("fetch failed")));
    const unset = setup(() => json({}), { url: null });
    const a = await down.agent.post("/ml/anomaly").send({ monthly_revenue: SERIES });
    const b = await unset.agent.post("/ml/anomaly").send({ monthly_revenue: SERIES });
    expect([a.status, b.status]).toEqual([503, 503]);
    expect(a.body).toMatchObject({ error: { code: "ML_UNAVAILABLE" } });
    expect(unset.calls).toHaveLength(0);
  });

  it("answers 502 for a failure or an answer it does not understand, and 400 for a refusal", async () => {
    const broken = await setup(() => json({ detail: "boom" }, 500)).agent.post("/ml/anomaly").send({ monthly_revenue: SERIES });
    const garbled = await setup(() => json({ flagged: "yes" })).agent.post("/ml/anomaly").send({ monthly_revenue: SERIES });
    const refused = await setup(() => json({ detail: "send vulnerability" }, 422)).agent.post("/ml/climate-cashflow").send(BUSINESS);
    expect([broken.status, garbled.status, refused.status]).toEqual([502, 502, 400]);
    expect(broken.body).toMatchObject({ error: { code: "ML_FAILED" } });
  });
});

describe("GET /ml/status", () => {
  it("reports which models are loaded", async () => {
    const { agent } = setup(() => json({ status: "ok", models: { flood: true, storm: true, anomaly: true }, hazard_params: true }));
    const res = await agent.get("/ml/status");
    expect(res.body).toEqual({ available: true, models: { flood: true, storm: true, anomaly: true }, hazard_params: true, reason: null });
  });

  it("says unavailable, with 200, when the service is down", async () => {
    const { agent } = setup(() => Promise.reject(new TypeError("fetch failed")));
    const res = await agent.get("/ml/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false, models: {} });
  });
});

describe("/ml guards", () => {
  it("needs a signed-in user", async () => {
    const { app, calls } = setup(() => json({}));
    const res = await request(app).post("/ml/anomaly").send({ monthly_revenue: SERIES });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("has its own rate limit", async () => {
    const { agent } = setup(() => json({ status: "ok", models: {} }), { rateLimit: 2 });
    await agent.get("/ml/status");
    await agent.get("/ml/status");
    expect((await agent.get("/ml/status")).status).toBe(429);
  });

  it("reads its URL from ML_SERVICE_URL and ignores a bad one", () => {
    expect(loadMlEnv({ ML_SERVICE_URL: "http://localhost:8001" }).url).toBe("http://localhost:8001");
    expect(loadMlEnv({ ML_SERVICE_URL: "not a url" }).url).toBeNull();
    expect(loadMlEnv({}).url).toBeNull();
  });
});
