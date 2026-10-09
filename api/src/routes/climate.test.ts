import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { connectDb, disconnectDb, prisma } from "../config/db.js";
import { createClimateService } from "../services/climate/profile.service.js";
import { climateProfileSchema, type ClimateProfile } from "../services/climate/schema.js";
import { fakeOpenMeteo, type FakeClimate } from "../services/climate/testing/fake-open-meteo.js";

// Integration tests: real Express app and Postgres, synthetic Open-Meteo data
const START = new Date("2026-10-09T06:00:00Z");
const HOUR_MS = 3_600_000;
const GUWAHATI = { lat: 26.1445, lon: 91.7362 };
const silent = { error: vi.fn(), warn: vi.fn() };
let clock = START;

function setup(climate: Partial<FakeClimate> = {}, rateLimit = 1000) {
  const om = fakeOpenMeteo(() => clock, climate);
  const service = createClimateService({
    prisma,
    openMeteo: om,
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
  return { app, om, profile };
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
    expect(om.calls).toEqual(["forecast"]);

    om.calls.length = 0;
    clock = new Date(START.getTime() + 25 * HOUR_MS);
    await profile();
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

  it("serves stale cache with low confidence when a forecast refresh fails", async () => {
    const { om, profile } = setup();
    await profile();
    om.climateOf.failing = ["forecast"];
    clock = new Date(START.getTime() + 7 * HOUR_MS);

    const { res, body } = await profile();

    expect(res.status).toBe(200);
    expect(body.confidence).toBe("low");
    expect(body.warnings.join()).toContain(
      "forecast_unavailable: serving cached data from 2026-10-09T11:30:00+05:30",
    );
    expect(body.data_freshness.forecast_issued_at).toBe("2026-10-09T11:30:00+05:30");
    expect(await prisma.climateResponse.findFirst({ where: { api: "forecast" } })).toMatchObject({
      status: "stale",
    });
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
