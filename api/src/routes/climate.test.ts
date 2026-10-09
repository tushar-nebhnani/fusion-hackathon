import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { connectDb, disconnectDb, prisma } from "../config/db.js";
import type { ClimateAgent } from "../services/climate/agent.js";
import { createClimateService } from "../services/climate/profile.service.js";
import { climateProfileSchema, type ClimateProfile } from "../services/climate/schema.js";
import { fakeAgent } from "../services/climate/testing/fake-agent.js";
import { fakeOpenMeteo, type FakeClimate } from "../services/climate/testing/fake-open-meteo.js";
import { memoryCache } from "../services/climate/testing/memory-cache.js";

// Integration tests: real Express app and Postgres, synthetic Open-Meteo data
const START = new Date("2026-10-09T06:00:00Z");
const HOUR_MS = 3_600_000;
const GUWAHATI = { lat: 26.1445, lon: 91.7362 };
const silent = { error: vi.fn(), warn: vi.fn() };
let clock = START;

function setup(climate: Partial<FakeClimate> = {}, rateLimit = 1000, agent?: ClimateAgent) {
  const om = fakeOpenMeteo(() => clock, climate);
  const cache = memoryCache();
  const service = createClimateService({
    prisma,
    openMeteo: om,
    cache,
    agent,
    now: () => clock,
    logger: silent,
  });
  const app = createApp({
    climate: service,
    checkDb: connectDb,
    upstreamStatus: () => om.status(),
    climateRateLimit: rateLimit,
  });
  const profile = async (point: object = GUWAHATI) => {
    const res = await request(app).post("/climate/profile").send(point);
    return { res, body: res.body as ClimateProfile };
  };
  return { app, om, cache, profile, service };
}

const hazard = (body: ClimateProfile, name: string) =>
  body.hazards.find((h) => h.hazard === name);

beforeEach(async () => {
  clock = START;
  silent.error.mockClear();
  silent.warn.mockClear();
  await prisma.$executeRaw`
    TRUNCATE TABLE request_log, cell_events, hazard_scores, climate_metrics,
      climate_responses, cell_hazard_relevance, point_static_features, points, grid_cells
    RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("POST /climate/profile", () => {
  it("runs the full pipeline on a cache miss and returns a valid profile", async () => {
    const { om, profile } = setup();

    const { res, body } = await profile();

    expect(res.status).toBe(200);
    expect(() => climateProfileSchema.parse(body)).not.toThrow();
    expect(body.cache).toBe("miss");
    expect(body.location).toEqual({
      lat: 26.1445,
      lon: 91.7362,
      cells: {
        historical: "0.1:26.1:91.7",
        climate: "0.1:26.1:91.7",
        flood: "0.05:26.15:91.75",
        forecast: "0.1:26.1:91.7",
      },
    });
    expect([...om.calls].sort()).toEqual([
      "archive",
      "climate",
      "elevation",
      "flood_forecast",
      "flood_history",
      "forecast",
    ]);
    expect(hazard(body, "heat")).toMatchObject({ relevance: "primary", relevance_method: "static" });
    expect(hazard(body, "river_flood")?.relevance).toBe("primary");
    expect(hazard(body, "cold_wave")?.relevance).toBe("dormant");
    expect(hazard(body, "flash_flood")?.components).toHaveProperty("structural");
    expect(hazard(body, "heat")?.components).not.toHaveProperty("structural");
    expect(body.active_events).toEqual([]);
    expect(body.data_freshness).toEqual({
      forecast_issued_at: "2026-10-09T11:30:00+05:30",
      history_until: "2026-10-03",
    });
    // The World Bank raster is not wired in, so confidence cannot be "high"
    expect(body.confidence).toBe("med");
    expect(body.warnings).toEqual([expect.stringContaining("flood_exposure_unavailable")]);
  });

  it("saves everything, including dormant results", async () => {
    await setup().profile();

    expect(await prisma.hazardCatalog.count()).toBe(6);
    expect(await prisma.gridCell.count()).toBe(2);
    expect(await prisma.point.count()).toBe(1);
    expect(await prisma.pointStaticFeatures.findFirst()).toMatchObject({
      elevationM: 50,
      relativeElevationM: -5,
      floodExposureShare: null,
    });
    expect(await prisma.cellHazardRelevance.count()).toBe(6);
    expect(await prisma.cellHazardRelevance.count({ where: { relevance: "dormant" } })).toBeGreaterThan(0);
    expect(await prisma.climateResponse.count()).toBe(5);
    expect(await prisma.hazardScore.count()).toBe(6);
    expect(await prisma.requestLog.findFirst()).toMatchObject({ cacheResult: "miss" });

    const kinds = await prisma.climateMetric.groupBy({ by: ["kind"], _count: true });
    expect(kinds.map((k) => k.kind).sort()).toEqual(["forecast", "observed", "projection"]);
    const tmaxDays = await prisma.climateMetric.count({
      where: { variable: "temperature_2m_max", kind: "observed" },
    });
    expect(tmaxDays).toBeGreaterThan(11_000);
  });

  it("serves a complete hit from cache with no upstream calls", async () => {
    const { om, profile } = setup();
    const first = await profile();
    om.calls.length = 0;

    const second = await profile();

    expect(second.body.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
    expect(second.body.hazards).toEqual(first.body.hazards);
    expect(second.body.overall_climate_risk).toBe(first.body.overall_climate_risk);
    expect(await prisma.requestLog.count()).toBe(2);
    expect(await prisma.hazardScore.count()).toBe(6);
  });

  it("serves screening results and forecasts from the cache, not Postgres", async () => {
    const { om, cache, profile } = setup();
    const first = await profile();
    expect([...cache.store.keys()].sort()).toEqual([
      expect.stringMatching(/^climate:relevance:0\.05:/),
      expect.stringMatching(/^climate:relevance:0\.1:/),
      expect.stringMatching(/^climate:response:flood_forecast:/),
      expect.stringMatching(/^climate:response:forecast:/),
    ]);
    // With the Postgres copies gone, only the cache can answer
    await prisma.cellHazardRelevance.deleteMany();
    await prisma.climateResponse.deleteMany();
    om.calls.length = 0;

    const second = await profile();

    expect(second.body.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
    expect(second.body.hazards).toEqual(first.body.hazards);
    expect(second.body.data_freshness).toEqual(first.body.data_freshness);
  });

  it("falls back to Postgres and refills the cache when the cache is empty", async () => {
    const { om, cache, profile } = setup();
    await profile();
    cache.store.clear();
    om.calls.length = 0;

    const { body } = await profile();

    expect(body.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
    expect(cache.store.size).toBe(4);
  });

  it("expires cache entries when the data does: 6h forecasts, 90d screening", async () => {
    const { cache, profile } = setup();
    await profile();

    const ttlHours = (prefix: string) =>
      [...cache.store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, entry]) => entry.ttlMs / HOUR_MS);
    expect(ttlHours("climate:response:forecast:")).toEqual([6]);
    expect(ttlHours("climate:response:flood_forecast:")).toEqual([6]);
    expect(ttlHours("climate:relevance:")).toEqual([90 * 24, 90 * 24]);
  });

  it("shares cached cell data with a nearby point, fetching only its elevation", async () => {
    const { om, profile } = setup();
    await profile();
    om.calls.length = 0;

    const { body } = await profile({ lat: 26.1451, lon: 91.737 });

    expect(body.cache).toBe("partial_hit");
    expect(om.calls).toEqual(["elevation"]);
    expect(await prisma.point.count()).toBe(2);
    expect(await prisma.gridCell.count()).toBe(2);
  });

  it("refetches only the layers that have gone stale", async () => {
    const { om, profile } = setup();
    await profile();

    om.calls.length = 0;
    clock = new Date(START.getTime() + 7 * HOUR_MS);
    const afterSevenHours = await profile();
    expect(afterSevenHours.body.cache).toBe("partial_hit");
    expect([...om.calls].sort()).toEqual(["flood_forecast", "forecast"]);
  });

  it("re-screens relevance after 90 days", async () => {
    const { om, profile } = setup();
    await profile();
    om.calls.length = 0;
    clock = new Date(START.getTime() + 91 * 24 * HOUR_MS);

    const { body } = await profile();

    expect(body.cache).toBe("miss");
    expect(om.calls).toContain("archive");
    expect(om.calls).toContain("flood_history");
    expect(om.calls).not.toContain("elevation");
  });

  it("skips the river forecast while river flood is dormant", async () => {
    const { om, profile } = setup({ riverDischarge: null });

    const { body } = await profile();

    expect(hazard(body, "river_flood")).toMatchObject({ relevance: "dormant" });
    expect(om.calls).not.toContain("flood_forecast");
    expect(om.calls).toHaveLength(5);
  });

  it("fetches only tripwire variables for dormant hazards", async () => {
    const { profile } = setup({ hotDaysPerYear: 0, heavyRainDaysPerYear: 0, riverDischarge: null });
    await profile();

    const forecast = await prisma.climateResponse.findFirstOrThrow({ where: { api: "forecast" } });

    expect(forecast.variablesRequested).toEqual(["precipitation_sum", "temperature_2m_max"]);
  });

  it("promotes a dormant hazard and raises an event when the tripwire trips", async () => {
    const { om, profile } = setup({
      heavyRainDaysPerYear: 0,
      forecastRain: [0, 60, 70, 80, 0, 0, 0],
    });

    const { body } = await profile();

    expect(hazard(body, "flash_flood")).toMatchObject({
      relevance: "secondary",
      tripwire_promoted: true,
    });
    expect(body.active_events).toEqual([
      {
        hazard: "flash_flood",
        severity: "warning",
        window_start: "2026-10-10",
        window_end: "2026-10-12",
        confidence: 0.6,
      },
    ]);
    expect(await prisma.cellEvent.findMany()).toMatchObject([
      { hazard: "flash_flood", severity: "warning", status: "open", cellId: "0.1:26.1:91.7" },
    ]);
    // The stored relevance stays dormant: the promotion is temporary
    expect(
      await prisma.cellHazardRelevance.findFirst({ where: { hazard: "flash_flood" } }),
    ).toMatchObject({ relevance: "dormant" });

    // Next forecast run is calm again: the event closes
    om.climateOf.forecastRain = [];
    clock = new Date(START.getTime() + 7 * HOUR_MS);
    const later = await profile();
    expect(later.body.active_events).toEqual([]);
    expect(hazard(later.body, "flash_flood")?.relevance).toBe("dormant");
    expect(await prisma.cellEvent.findMany()).toMatchObject([{ status: "closed" }]);
  });

  it("escalates an open event when the forecast worsens", async () => {
    const { om, profile } = setup({ forecastDischarge: [500, 2500, 500] });
    const first = await profile();
    expect(first.body.active_events).toMatchObject([{ hazard: "river_flood", severity: "watch" }]);

    om.climateOf.forecastDischarge = [500, 9000, 9000];
    clock = new Date(START.getTime() + 25 * HOUR_MS);
    const second = await profile();

    expect(second.body.active_events).toMatchObject([{ hazard: "river_flood", severity: "severe" }]);
    expect(await prisma.cellEvent.findMany()).toMatchObject([
      { hazard: "river_flood", severity: "severe", status: "escalated", cellId: "0.05:26.15:91.75" },
    ]);
  });

  it("raises the overall risk when a severe forecast arrives", async () => {
    const calm = await setup().profile();
    await prisma.$executeRaw`TRUNCATE TABLE grid_cells RESTART IDENTITY CASCADE`;
    const stormy = await setup({
      forecastRain: [0, 150, 150, 150],
      forecastTmax: [46, 46, 46],
    }).profile();

    expect(stormy.body.overall_climate_risk).toBeGreaterThan(calm.body.overall_climate_risk);
    expect(stormy.body.active_events.map((e) => e.hazard).sort()).toEqual(["flash_flood", "heat"]);
  });

  it("fetches the archive before projections, never alongside", async () => {
    const { om, profile } = setup();
    await profile();

    expect(om.calls.indexOf("archive")).toBeLessThan(om.calls.indexOf("climate"));
  });

  it("fills in projections later when they are rate limited on the first request", async () => {
    const { om, profile } = setup({ failing: ["climate"] });

    const first = await profile();
    expect(first.res.status).toBe(200);
    expect(first.body.cache).toBe("miss");
    expect(first.body.warnings.join()).toContain("climate_projections_unavailable");

    // Inside the retry window nothing is refetched
    om.climateOf.failing = [];
    om.calls.length = 0;
    clock = new Date(START.getTime() + 60_000);
    const soon = await profile();
    expect(om.calls).toEqual([]);
    expect(soon.body.warnings.join()).toContain("climate_projections_unavailable");

    // After it, only the projections are fetched: no second screening
    clock = new Date(START.getTime() + 6 * 60_000);
    const later = await profile();
    expect(om.calls).toEqual(["climate"]);
    expect(later.body.cache).toBe("partial_hit");
    expect(later.body.warnings.join()).not.toContain("climate_projections_unavailable");
    expect(await prisma.climateResponse.count({ where: { api: "climate" } })).toBe(1);

    om.calls.length = 0;
    const settled = await profile();
    expect(settled.body.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
  });

  it("returns 503 when the history is unavailable and nothing is cached", async () => {
    const { profile } = setup({ failing: ["archive"] });

    const { res } = await profile();

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Climate data sources are unavailable",
        step: "fetch_screening",
      },
    });
    expect(await prisma.cellHazardRelevance.count()).toBe(0);
  });

  it("leaves a forecast out rather than serving it stale", async () => {
    const { om, profile } = setup();
    await profile();
    om.climateOf.failing = ["forecast"];
    clock = new Date(START.getTime() + 7 * HOUR_MS);

    const { res, body } = await profile();

    expect(res.status).toBe(200);
    expect(body.confidence).toBe("low");
    expect(body.warnings.join()).toContain("forecast_unavailable: forecast signal left out");
    expect(body.warnings.join()).not.toContain("serving cached data");
    expect(body.data_freshness.forecast_issued_at).toBeNull();
  });

  it("returns 503 rather than an expired screening when the history cannot be refetched", async () => {
    const { om, profile } = setup();
    await profile();
    om.climateOf.failing = ["archive"];
    clock = new Date(START.getTime() + 91 * 24 * HOUR_MS);

    const { res } = await profile();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("re-screens the river as unknown rather than serving its expired profile", async () => {
    const { om, profile } = setup();
    await profile();
    om.climateOf.failing = ["flood_history"];
    clock = new Date(START.getTime() + 91 * 24 * HOUR_MS);

    const { res, body } = await profile();

    expect(res.status).toBe(200);
    expect(body.warnings.join()).toContain(
      "river_discharge_history_unavailable: river flood treated as secondary",
    );
    expect(body.warnings.join()).not.toContain("expired");
    expect(hazard(body, "river_flood")?.relevance).toBe("secondary");
  });

  it("returns a partial response when secondary sources fail", async () => {
    const { profile } = setup({ failing: ["climate", "elevation", "flood_history", "flood_forecast"] });

    const { res, body } = await profile();

    expect(res.status).toBe(200);
    expect(body.confidence).toBe("low");
    expect(body.warnings.map((w) => w.split(":")[0]).sort()).toEqual([
      "climate_projections_unavailable",
      "elevation_unavailable",
      "flood_exposure_unavailable",
      "flood_forecast_unavailable",
      "river_discharge_history_unavailable",
    ]);
    // An unknown river is never written off as dormant
    expect(hazard(body, "river_flood")?.relevance).toBe("secondary");
    // Degraded screening is retried the next day, not in 90 days
    const river = await prisma.cellHazardRelevance.findFirstOrThrow({
      where: { hazard: "river_flood" },
    });
    expect(river.reviewAfter.getTime() - START.getTime()).toBe(24 * HOUR_MS);
  });

  it("still responds when a database write fails", async () => {
    const { profile } = setup();
    const spy = vi
      .spyOn(prisma.requestLog, "create")
      .mockRejectedValue(new Error("disk full"));

    const { res, body } = await profile();
    const attempts = spy.mock.calls.length;
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(body.warnings.join()).toContain("persistence_failed");
    // One retry, then give up
    expect(attempts).toBe(2);
    expect(silent.error).toHaveBeenCalled();
  });

  it("screens a new cell only once when two requests arrive together", async () => {
    const { om, profile } = setup();

    const [a, b] = await Promise.all([profile(), profile()]);

    expect([a.body.cache, b.body.cache].sort()).toEqual(["complete_hit", "miss"]);
    expect(om.calls.filter((c) => c === "archive")).toHaveLength(1);
    expect(om.calls).toHaveLength(6);
  });

  it.each([
    ["no body", undefined, 400, "MISSING_COORDINATES"],
    ["missing lon", { lat: 26.1 }, 400, "MISSING_COORDINATES"],
    ["null lat", { lat: null, lon: 91.7 }, 400, "MISSING_COORDINATES"],
    ["string numbers", { lat: "26.1", lon: "91.7" }, 400, "INVALID_COORDINATES"],
    ["operator object", { lat: { $gt: 0 }, lon: 91.7 }, 400, "INVALID_COORDINATES"],
    ["array body", [26.1, 91.7], 400, "MISSING_COORDINATES"],
    ["lat too large", { lat: 95, lon: 80 }, 400, "OUT_OF_RANGE"],
    ["lon too small", { lat: 20, lon: -181 }, 400, "OUT_OF_RANGE"],
    ["outside India", { lat: 48.8566, lon: 2.3522 }, 422, "OUTSIDE_COVERAGE"],
  ])("rejects %s", async (_name, payload, status, code) => {
    const { app, om } = setup();

    const res = await request(app).post("/climate/profile").send(payload);

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: { code, step: "input_validation" } });
    expect(om.calls).toEqual([]);
    expect(await prisma.point.count()).toBe(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await request(setup().app)
      .post("/climate/profile")
      .set("content-type", "application/json")
      .send('{"lat": 26.1, "lon": ');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rate limits each client", async () => {
    const { app } = setup({}, 2);
    const bad = () => request(app).post("/climate/profile").send({});

    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(400);
    const third = await bad();
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("scheduled refresh", () => {
  const AN_HOUR_LATER = new Date(START.getTime() + HOUR_MS);

  it("refetches the forecast layers of a known location even while they are fresh", async () => {
    const { om, cache, profile, service } = setup();
    await profile();
    om.calls.length = 0;
    clock = AN_HOUR_LATER;

    const summary = await service.refreshAll();

    expect(summary).toEqual({ points: 1, failed: 0 });
    expect([...om.calls].sort()).toEqual(["flood_forecast", "forecast"]);

    // Postgres holds the new payloads
    const stored = await prisma.climateResponse.findMany({
      where: { api: { in: ["forecast", "flood_forecast"] } },
    });
    expect(stored.map((row) => row.fetchedAt)).toEqual([AN_HOUR_LATER, AN_HOUR_LATER]);
    expect(stored.every((row) => row.status === "fresh")).toBe(true);

    // So does the cache
    const cached = [...cache.store.entries()]
      .filter(([key]) => key.startsWith("climate:response:"))
      .map(([, entry]) => (JSON.parse(entry.value) as { fetchedAt: string }).fetchedAt);
    expect(cached).toEqual([AN_HOUR_LATER.toISOString(), AN_HOUR_LATER.toISOString()]);

    // Scores are recomputed, but a refresh is not logged as a client request
    expect(await prisma.hazardScore.count()).toBe(12);
    expect(await prisma.requestLog.count()).toBe(1);
  });

  it("leaves the next request a complete hit on the refreshed data", async () => {
    const { om, profile, service } = setup();
    await profile();
    clock = AN_HOUR_LATER;
    await service.refreshAll();
    om.calls.length = 0;

    const { body } = await profile();

    expect(body.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
    expect(body.data_freshness.forecast_issued_at).toBe("2026-10-09T12:30:00+05:30");
  });

  it("does not refetch history, projections or elevation", async () => {
    const { om, profile, service } = setup();
    await profile();
    om.calls.length = 0;
    clock = AN_HOUR_LATER;

    await service.refreshAll();

    expect(om.calls).not.toContain("archive");
    expect(om.calls).not.toContain("climate");
    expect(om.calls).not.toContain("flood_history");
    expect(om.calls).not.toContain("elevation");
  });

  it("fetches each cell once, however many locations share it", async () => {
    const { om, profile, service } = setup();
    await profile();
    await profile({ lat: 26.1451, lon: 91.737 });
    om.calls.length = 0;
    clock = AN_HOUR_LATER;

    const summary = await service.refreshAll();

    expect(summary).toEqual({ points: 2, failed: 0 });
    expect([...om.calls].sort()).toEqual(["flood_forecast", "forecast"]);
  });

  it("opens an event when a refreshed forecast turns dangerous, with no request needed", async () => {
    const { om, profile, service } = setup();
    await profile();
    expect(await prisma.cellEvent.count()).toBe(0);

    om.climateOf.forecastRain = [0, 150, 150, 150];
    clock = new Date(START.getTime() + 6 * HOUR_MS);
    await service.refreshAll();

    expect(await prisma.cellEvent.findMany()).toMatchObject([
      { hazard: "flash_flood", severity: "warning", status: "open", cellId: "0.1:26.1:91.7" },
    ]);
  });

  it("keeps still-valid data untouched when the refresh cannot reach Open-Meteo", async () => {
    const { om, profile, service } = setup();
    const before = await profile();
    om.climateOf.failing = ["forecast", "flood_forecast"];
    clock = AN_HOUR_LATER;

    const summary = await service.refreshAll();

    expect(summary).toEqual({ points: 1, failed: 0 });
    expect(
      await prisma.climateResponse.findFirstOrThrow({ where: { api: "forecast" } }),
    ).toMatchObject({ fetchedAt: START, status: "fresh" });

    om.climateOf.failing = [];
    om.calls.length = 0;
    const after = await profile();
    expect(after.body.cache).toBe("complete_hit");
    expect(after.body.confidence).toBe(before.body.confidence);
    expect(after.body.warnings).toEqual(before.body.warnings);
  });

  it("skips a location that fails and still refreshes the rest", async () => {
    const { om, profile, service } = setup();
    await profile();
    await profile({ lat: 26.1451, lon: 91.737 });
    om.calls.length = 0;
    clock = AN_HOUR_LATER;
    const spy = vi.spyOn(prisma.point, "upsert").mockRejectedValueOnce(new Error("deadlock"));

    const summary = await service.refreshAll();
    spy.mockRestore();

    expect(summary).toEqual({ points: 2, failed: 1 });
    expect([...om.calls].sort()).toEqual(["flood_forecast", "forecast"]);
    expect(silent.warn).toHaveBeenCalled();
  });

  it("does nothing when no location is known yet", async () => {
    const { om, service } = setup();

    expect(await service.refreshAll()).toEqual({ points: 0, failed: 0 });
    expect(om.calls).toEqual([]);
  });
});

describe("climate agent", () => {
  const MINUTE_MS = 60_000;

  it("raises a hazard category in fetch 1 and records why", async () => {
    const { agent, reviews } = fakeAgent({ categories: { cold_wave: "secondary" } });
    const { body } = await setup({}, 1000, agent).profile();

    expect(hazard(body, "cold_wave")).toMatchObject({
      relevance: "secondary",
      relevance_method: "agent_raised",
    });
    expect(hazard(body, "cold_wave")?.reason).toContain("Agent review: fake rationale for cold_wave");
    // Weather hazards and the river are reviewed separately, as they are screened
    expect(reviews.map((r) => r.hazards.map((h) => h.hazard).sort())).toEqual(
      expect.arrayContaining([
        ["cold_wave", "drought", "flash_flood", "heat", "storm"],
        ["river_flood"],
      ]),
    );
    expect(
      await prisma.cellHazardRelevance.findFirst({ where: { hazard: "cold_wave" } }),
    ).toMatchObject({ relevance: "secondary", method: "agent_raised", agentVersion: "fake-agent/1" });
  });

  it("never lowers a category the rules measured, but marks it as reviewed", async () => {
    const { agent } = fakeAgent({ categories: { heat: "dormant" } });
    const { body } = await setup({}, 1000, agent).profile();

    expect(hazard(body, "heat")).toMatchObject({ relevance: "primary", relevance_method: "static" });
    expect(hazard(body, "heat")?.reason).not.toContain("Agent review");
    expect(await prisma.cellHazardRelevance.findFirst({ where: { hazard: "heat" } })).toMatchObject({
      method: "static",
      agentVersion: "fake-agent/1",
    });
  });

  it("uses the agent's score as the forecast component in fetch 2", async () => {
    const { agent, scored } = fakeAgent({ scores: { storm: 0.9 } });

    const { body } = await setup({}, 1000, agent).profile();

    expect(hazard(body, "storm")).toMatchObject({
      components: { forecast: 0.9 },
      forecast_source: "agent",
      forecast_note: "fake note for storm",
    });
    expect(climateProfileSchema.safeParse(body).success).toBe(true);
    // The agent is given the rule score and the forecast window it is judging
    expect(scored[0]).toMatchObject({ window: { start: "2026-10-09", end: "2026-10-15" } });
    expect(scored[0]?.hazards).toHaveLength(6);
    expect(scored[0]?.weather?.time).toHaveLength(7);
    expect(await prisma.hazardScore.findFirst({ where: { hazard: "storm" } })).toMatchObject({
      forecast: 0.9,
    });
  });

  it("adds no agent fields when there is no agent", async () => {
    const { body } = await setup().profile();

    expect(hazard(body, "storm")).not.toHaveProperty("forecast_source");
    expect(hazard(body, "storm")).not.toHaveProperty("forecast_note");
    expect(await prisma.cellHazardRelevance.count({ where: { agentVersion: null } })).toBe(6);
  });

  it("is not called again on a complete hit", async () => {
    const { agent, calls } = fakeAgent({ scores: { storm: 0.9 } });
    const { om, profile } = setup({}, 1000, agent);
    const first = await profile();
    calls.length = 0;
    om.calls.length = 0;

    const second = await profile();

    expect(second.body.cache).toBe("complete_hit");
    expect(calls).toEqual([]);
    expect(om.calls).toEqual([]);
    expect(second.body.hazards).toEqual(first.body.hazards);
  });

  it("scores again when the forecast is refreshed", async () => {
    const { agent, calls } = fakeAgent();
    const { profile } = setup({}, 1000, agent);
    await profile();
    calls.length = 0;
    clock = new Date(START.getTime() + 7 * HOUR_MS);

    await profile();

    expect(calls).toEqual(["score"]);
  });

  it("falls back to the rules, with a warning, when the agent fails", async () => {
    const fake = fakeAgent({ categories: { cold_wave: "secondary" }, scores: { storm: 0.9 } });
    fake.state.failing = true;

    const { res, body } = await setup({}, 1000, fake.agent).profile();

    expect(res.status).toBe(200);
    expect(hazard(body, "cold_wave")).toMatchObject({ relevance: "dormant", relevance_method: "static" });
    expect(hazard(body, "storm")).not.toHaveProperty("forecast_source");
    expect(hazard(body, "storm")?.components.forecast).not.toBe(0.9);
    expect(body.warnings.join()).toContain("agent_unavailable: hazard categories are rule-based only");
    expect(body.warnings.join()).toContain("agent_unavailable: forecast scores are rule-based only");
    expect(await prisma.cellHazardRelevance.count({ where: { agentVersion: null } })).toBe(6);
  });

  it("leaves a failing agent alone for 5 minutes, then reviews what it missed", async () => {
    const fake = fakeAgent({ categories: { cold_wave: "secondary" } });
    fake.state.failing = true;
    const { om, profile } = setup({}, 1000, fake.agent);
    await profile();
    const attempts = fake.calls.length;
    fake.state.failing = false;

    clock = new Date(START.getTime() + 2 * MINUTE_MS);
    await profile();
    expect(fake.calls).toHaveLength(attempts);

    om.calls.length = 0;
    clock = new Date(START.getTime() + 6 * MINUTE_MS);
    const { body } = await profile();

    // The stored screening is reviewed in place: no history is fetched again.
    // Only the forecast is, because the raised hazard now needs its variables.
    expect(om.calls).toEqual(["forecast"]);
    expect(hazard(body, "cold_wave")).toMatchObject({ relevance_method: "agent_raised" });
    expect(hazard(body, "storm")).toMatchObject({ forecast_source: "agent" });
    expect(await prisma.cellHazardRelevance.count({ where: { agentVersion: null } })).toBe(0);
  });

  it("reviews cells that were screened before the agent was switched on", async () => {
    await setup().profile();
    const { agent, calls } = fakeAgent({ categories: { cold_wave: "secondary" } });
    const { om, profile } = setup({}, 1000, agent);

    const { body } = await profile();

    // No history is fetched again; the raised hazard adds a forecast variable
    expect(om.calls).toEqual(["forecast"]);
    expect(calls.filter((c) => c === "review")).toHaveLength(2);
    expect(hazard(body, "cold_wave")).toMatchObject({ relevance_method: "agent_raised" });
    // The original 90-day review date is kept
    const row = await prisma.cellHazardRelevance.findFirst({ where: { hazard: "cold_wave" } });
    expect(row?.reviewAfter.toISOString()).toBe("2027-01-07T06:00:00.000Z");
  });
});

describe("GET /climate/events", () => {
  it("returns active events only", async () => {
    const { app } = setup({ forecastTmax: [38, 46, 47] });

    const res = await request(app).get("/climate/events?lat=26.1445&lon=91.7362");

    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual([
      "active_events",
      "cache",
      "data_freshness",
      "location",
      "warnings",
    ]);
    expect(res.body).toMatchObject({
      cache: "miss",
      active_events: [
        { hazard: "heat", severity: "warning", window_start: "2026-10-10", window_end: "2026-10-11" },
      ],
    });
  });

  it.each([
    ["/climate/events", 400, "MISSING_COORDINATES"],
    ["/climate/events?lat=26.1", 400, "MISSING_COORDINATES"],
    ["/climate/events?lat=abc&lon=91.7", 400, "INVALID_COORDINATES"],
    // Bracket keys are not parsed into arrays or objects, so `lat` is absent
    ["/climate/events?lat[]=26.1&lon=91.7", 400, "MISSING_COORDINATES"],
    ["/climate/events?lat[$ne]=1&lon=91.7", 400, "MISSING_COORDINATES"],
    ["/climate/events?lat=26.1&lat=27&lon=91.7", 400, "INVALID_COORDINATES"],
    ["/climate/events?lat=999&lon=91.7", 400, "OUT_OF_RANGE"],
    ["/climate/events?lat=48.85&lon=2.35", 422, "OUTSIDE_COVERAGE"],
  ])("validates %s", async (url, status, code) => {
    const { app, om } = setup();

    const res = await request(app).get(url);

    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: { code } });
    expect(om.calls).toEqual([]);
  });
});

describe("GET /climate/cell/:cellId", () => {
  it("shows what is stored for a cell, without raw payloads", async () => {
    const { app, profile } = setup();
    await profile();

    const res = await request(app).get("/climate/cell/0.1:26.1:91.7");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      cell: { id: "0.1:26.1:91.7", resolutionDeg: 0.1, latCenter: 26.1, lonCenter: 91.7 },
      events: [],
    });
    const body = res.body as {
      relevance: { hazard: string }[];
      responses: Record<string, unknown>[];
      metricCount: number;
    };
    expect(body.relevance.map((r) => r.hazard)).toEqual([
      "cold_wave",
      "drought",
      "flash_flood",
      "heat",
      "storm",
    ]);
    expect(body.responses.map((r) => r.api)).toEqual(["archive", "climate", "forecast"]);
    expect(body.responses.every((r) => !("response" in r))).toBe(true);
    expect(body.metricCount).toBeGreaterThan(100_000);
  });

  it("returns 404 for a valid cell with no data", async () => {
    const res = await request(setup().app).get("/climate/cell/0.1:19.1:72.9");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it.each([
    ["nonsense", "/climate/cell/abc"],
    ["off-grid id", "/climate/cell/0.05:26.13:91.75"],
    ["sql fragment", "/climate/cell/0.1:26.1:91.7'%20OR%20'1'='1"],
    ["encoded traversal", "/climate/cell/..%2F..%2Fetc%2Fpasswd"],
  ])("rejects %s with 400", async (_name, url) => {
    const res = await request(setup().app).get(url);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_CELL_ID" } });
  });
});

describe("unsupported methods", () => {
  it.each([
    ["get", "/climate/profile"],
    ["post", "/climate/events"],
    ["delete", "/climate/cell/0.1:26.1:91.7"],
  ] as const)("%s %s is a 404", async (method, url) => {
    const res = await request(setup().app)[method](url);
    expect(res.status).toBe(404);
  });
});
