import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, prisma } from "../../../config/db.js";
import { createClimateService } from "../profile.service.js";
import { fakeOpenMeteo, type FakeClimate } from "../testing/fake-open-meteo.js";
import { memoryCache } from "../testing/memory-cache.js";
import { FakeClock } from "./adapters/clock.js";
import { loadMonitorConfig } from "./config.js";
import type { WatchedLocation } from "./ports.js";
import { createMonitorRepo } from "./repo.js";
import {
  CHENNAI,
  CHENNAI_CELL,
  CHENNAI_NEIGHBOUR,
  PUNE,
  START,
  memoryLogger,
  recordingSink,
} from "./testing/fixtures.js";
import { createMonitor } from "./tick.js";

// The monitor on top of the real climate pipeline and the real test
// database. Only Open-Meteo is replaced, by the climate unit's own test
// double, so no test makes a network call.
const repo = createMonitorRepo(prisma);
const silent = { error: vi.fn(), warn: vi.fn() };
const HEAVY_RAIN = { forecastRain: [0, 130, 90] };

function setup(
  climate: Partial<FakeClimate> = {},
  watched: WatchedLocation[] = [CHENNAI, CHENNAI_NEIGHBOUR],
) {
  const clock = new FakeClock(START);
  const om = fakeOpenMeteo(() => clock.now(), climate);
  const service = createClimateService({
    prisma,
    openMeteo: om,
    cache: memoryCache(),
    now: () => clock.now(),
    logger: silent,
  });
  const alerts = recordingSink();
  const log = memoryLogger();
  const monitor = createMonitor({
    config: loadMonitorConfig({}),
    climate: service,
    source: { list: () => Promise.resolve(watched) },
    sink: alerts.sink,
    logger: log.logger,
    clock,
    repo,
    instanceId: "monitor-a",
  });
  // Runs the Chennai cell's next due check, with this forecast
  const check = async (forecast: Partial<FakeClimate> = {}) => {
    const cell = await repo.getCell(CHENNAI_CELL);
    if (cell) clock.set(cell.nextCheckAt);
    om.climateOf.forecastRain = forecast.forecastRain ?? [];
    om.climateOf.forecastTmax = forecast.forecastTmax ?? [];
    om.climateOf.forecastDischarge = forecast.forecastDischarge ?? [];
    om.calls.length = 0;
    const summary = await monitor.tick();
    const after = await repo.getCell(CHENNAI_CELL);
    if (!after) throw new Error("the cell was not created");
    return { summary, cell: after };
  };
  return { clock, om, service, alerts, log, monitor, check };
}

beforeEach(async () => {
  silent.error.mockClear();
  silent.warn.mockClear();
  await prisma.$executeRaw`
    TRUNCATE TABLE disaster_events, monitored_cells, request_log, cell_events, hazard_scores,
      climate_metrics, climate_responses, cell_hazard_relevance, point_static_features, points,
      grid_cells
    RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("monitor on the real climate pipeline", () => {
  it("screens a cell once on its first check, whatever the number of businesses", async () => {
    const { om, check } = setup();

    const { summary, cell } = await check();

    expect(summary).toMatchObject({ due: 1, checked: 1, failed: 0 });
    expect([...om.calls].sort()).toEqual([
      "archive",
      "climate",
      "elevation",
      "flood_forecast",
      "flood_history",
      "forecast",
    ]);
    expect(cell).toMatchObject({ level: "NORMAL", lastCheckedAt: START });
  });

  it("refetches only the forecast layers on every later check", async () => {
    const { om, check } = setup();
    await check();

    await check();

    expect([...om.calls].sort()).toEqual(["flood_forecast", "forecast"]);
  });

  it("makes one forecast call for two locations in a cell, and alerts both businesses", async () => {
    const { om, check, alerts } = setup();
    await check();

    const { summary, cell } = await check(HEAVY_RAIN);

    expect(om.calls.filter((call) => call === "forecast")).toHaveLength(1);
    expect(summary).toMatchObject({ checked: 1, suddenChanges: 1, alerts: 2 });
    expect(cell.level).toBe("WARNING");
    expect(alerts.events.map((event) => event.businessId)).toEqual(["SME-0142", "SME-0143"]);
    expect(alerts.events[0]).toMatchObject({
      hazard: "flash_flood",
      severity: "WARNING",
      windowStart: "2026-10-10",
      windowEnd: "2026-10-11",
      evidence: "130 mm rain forecast on 10 Oct, 80% probability",
    });
  });

  it("goes NORMAL, WARNING, two calm runs, then down to WATCH", async () => {
    const { check, alerts } = setup();
    const levels: string[] = [];
    const hoursToNext: number[] = [];
    const step = async (forecast: Partial<FakeClimate> = {}) => {
      const { cell } = await check(forecast);
      levels.push(cell.level);
      hoursToNext.push((cell.nextCheckAt.getTime() - (cell.lastCheckedAt?.getTime() ?? 0)) / 3_600_000);
    };

    await step();
    await step(HEAVY_RAIN);
    await step();
    await step();

    expect(levels).toEqual(["NORMAL", "WARNING", "WARNING", "WATCH"]);
    expect(hoursToNext).toEqual([6, 1, 1, 3]);
    expect(alerts.events).toHaveLength(2);
    expect(await prisma.disasterEvent.findMany()).toMatchObject([
      { hazard: "flash_flood", level: "WARNING", status: "pending" },
    ]);
  });

  it("alerts on a heatwave from the forecast's daily values", async () => {
    const { check, alerts } = setup({}, [CHENNAI]);
    await check();

    const { cell } = await check({ forecastTmax: [39, 43, 46] });

    expect(cell.level).toBe("WARNING");
    expect(alerts.events).toMatchObject([
      {
        hazard: "heat",
        severity: "WARNING",
        windowStart: "2026-10-10",
        windowEnd: "2026-10-11",
        evidence: "46 °C max temperature forecast on 11 Oct",
      },
    ]);
  });

  it("raises a river above its historical high to CRITICAL when heavy rain is close", async () => {
    const { check, alerts, service } = setup({}, [CHENNAI]);
    await check();
    const { forecast } = await service.getProfileWithForecast(CHENNAI);
    const high = forecast.riverHistory?.dischargeP99 ?? 0;

    await check({ forecastDischarge: [600, high + 500], forecastRain: [0, 0, 90] });

    const river = alerts.events.find((event) => event.hazard === "river_flood");
    expect(river).toMatchObject({ severity: "CRITICAL" });
    expect(river?.evidence).toContain("above the historical high of");
    expect(river?.evidence).toContain("90 mm rain forecast within 72 h");
    expect(alerts.events.map((event) => event.hazard).sort()).toEqual(["flash_flood", "river_flood"]);
  });

  it("trips the tripwire of a dormant hazard, with only the tripwire variables fetched", async () => {
    // No heavy-rain days in 30 years: flash flood is dormant in this cell
    const { check, alerts, service } = setup({ heavyRainDaysPerYear: 0 }, [CHENNAI]);
    await check();
    const { profile } = await service.getProfileWithForecast(CHENNAI);
    expect(profile.hazards.find((h) => h.hazard === "flash_flood")?.relevance).toBe("dormant");

    const { cell } = await check({ forecastRain: [0, 70] });

    expect(cell.level).toBe("WARNING");
    expect(alerts.events).toMatchObject([
      {
        hazard: "flash_flood",
        severity: "WARNING",
        evidence:
          "70 mm rain forecast on 10 Oct, probability not forecast; this hazard is normally dormant here",
      },
    ]);
    expect((await prisma.disasterEvent.findFirstOrThrow()).forecastValues).toMatchObject({
      dormant: true,
    });
  });

  it("leaves a fresh forecast in the shared cache, so the next API request is a complete hit", async () => {
    const { om, check, service } = setup({}, [CHENNAI]);
    await check();
    await check(HEAVY_RAIN);
    om.calls.length = 0;

    const profile = await service.getProfile(CHENNAI);

    expect(profile.cache).toBe("complete_hit");
    expect(om.calls).toEqual([]);
    expect(profile.active_events.map((event) => event.hazard)).toContain("flash_flood");
  });

  it("is recorded in the request log as the monitor", async () => {
    const { check } = setup({}, [CHENNAI]);
    await check();
    await check();

    const rows = await prisma.requestLog.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.requesterId, row.cacheResult])).toEqual([
      ["climate-monitor", "miss"],
      ["climate-monitor", "partial_hit"],
    ]);
  });

  it("keeps the cell's state when the history cannot be fetched, and screens it next tick", async () => {
    const { om, check, log, clock, monitor } = setup({ failing: ["archive"] }, [CHENNAI]);

    const first = await check();

    expect(first.summary).toMatchObject({ checked: 0, failed: 1 });
    expect(first.cell).toMatchObject({ level: "NORMAL", lastCheckedAt: null, nextCheckAt: START });
    expect(log.of("warn")[0]).toContain("UPSTREAM_UNAVAILABLE at fetch_screening");

    om.climateOf.failing = [];
    clock.advance(15 * 60_000);
    expect(await monitor.tick()).toMatchObject({ checked: 1, failed: 0 });
  });

  it("fails the check, and keeps the level, once the forecast is down and the cached one has expired", async () => {
    const { om, check, log } = setup({}, [CHENNAI]);
    await check(HEAVY_RAIN);
    await check(HEAVY_RAIN);
    om.climateOf.failing = ["forecast"];

    // While the cached forecast is under 6 hours old the unit still serves it
    let last = await check(HEAVY_RAIN);
    expect(last.summary).toMatchObject({ checked: 1, failed: 0 });

    for (let hour = 0; hour < 6; hour++) last = await check(HEAVY_RAIN);

    expect(last.summary).toMatchObject({ checked: 0, failed: 1 });
    expect(last.cell.level).toBe("WARNING");
    expect(log.of("warn").at(-1)).toContain("the weather forecast is unavailable");
  });

  it("checks each cell at its own pace", async () => {
    const { clock, monitor, om } = setup({}, [CHENNAI, PUNE]);
    await monitor.tick();
    om.climateOf.forecastRain = HEAVY_RAIN.forecastRain;
    clock.advanceHours(6);
    await monitor.tick();
    om.calls.length = 0;

    // Both cells are now at WARNING, so they are due again in an hour, not six
    clock.advanceHours(1);
    const summary = await monitor.tick();

    expect(summary).toMatchObject({ due: 2, checked: 2 });
    expect(om.calls.filter((call) => call === "forecast")).toHaveLength(2);
  });
});
