import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, prisma } from "../../../config/db.js";
import { parsePayload, UpstreamError, type UpstreamResult } from "../open-meteo.js";
import { addDays } from "../profile.service.js";
import type { LatLon } from "../types.js";
import { FakeClock } from "./adapters/clock.js";
import { groupByCell } from "./cells.js";
import { createMonitorRepo } from "./repo.js";
import {
  CHENNAI,
  CHENNAI_CELL,
  PUNE,
  PUNE_CELL,
  RIVER,
  SETTINGS,
  memoryLogger,
} from "./testing/fixtures.js";
import type { MonitorLevel, Tripwire } from "./types.js";
import { createVerifier } from "./verifyJob.js";

// The verification job against the real test database, with fixture
// observations in place of the ERA5 archive. "Today" is 20 Oct 2026, so
// observed data runs up to 15 Oct and the last week scanned is 9 to 15 Oct.
const NOW = new Date("2026-10-20T06:00:00Z");
const WATCHED_SINCE = new Date("2026-10-01T06:00:00Z");
const repo = createMonitorRepo(prisma);

const RAIN: Tripwire = { variable: "precipitation_sum", threshold: 64.5, direction: "above" };
const HEAT: Tripwire = { variable: "temperature_2m_max", threshold: 40, direction: "above" };
const DISCHARGE: Tripwire = { variable: "river_discharge", threshold: 1000, direction: "above" };

// Values by variable and day; any other day is ordinary weather
type Observations = Record<string, Record<string, number | null>>;

const ORDINARY_WEATHER = {
  precipitation_sum: 0,
  temperature_2m_max: 31,
  temperature_2m_min: 20,
  wind_gusts_10m_max: 20,
};

function setup(observed: { weather?: Observations; river?: Observations } = {}) {
  const log = memoryLogger();
  const calls: { api: string; lat: number; start: string; end: string }[] = [];
  const state = {
    // Latitude of a cell whose archive is unreachable
    archiveDownAt: null as number | null,
    riverDown: false,
    // The river indicators stored by the climate unit's screening, if any
    river: null as typeof RIVER | null,
  };

  function respond(
    api: string,
    values: Observations,
    ordinary: Record<string, number>,
    down: (point: LatLon) => boolean,
  ) {
    return (point: LatLon, start: string, end: string): Promise<UpstreamResult> => {
      calls.push({ api, lat: point.lat, start, end });
      if (down(point)) return Promise.reject(new UpstreamError(api, "simulated outage"));
      const time: string[] = [];
      for (let day = start; day <= end; day = addDays(day, 1)) time.push(day);
      const daily: Record<string, (string | number | null)[]> = { time };
      for (const name of new Set([...Object.keys(ordinary), ...Object.keys(values)])) {
        daily[name] = time.map((day) => {
          const scripted = values[name];
          return scripted && day in scripted ? (scripted[day] ?? null) : (ordinary[name] ?? null);
        });
      }
      return Promise.resolve(parsePayload(api, { daily }));
    };
  }

  const verifier = createVerifier({
    repo,
    relevance: {
      getRelevance: () =>
        Promise.resolve(
          state.river
            ? [
                {
                  hazard: "river_flood",
                  relevance: "primary" as const,
                  indicators: { river: state.river, primaryThreshold: 1000, projectionAdjustment: 0 },
                },
              ]
            : [],
        ),
    },
    openMeteo: {
      archive: respond(
        "archive",
        observed.weather ?? {},
        ORDINARY_WEATHER,
        (point) => point.lat === state.archiveDownAt,
      ),
      floodHistory: respond(
        "flood_history",
        observed.river ?? {},
        { river_discharge: 500 },
        () => state.riverDown,
      ),
    },
    clock: new FakeClock(NOW),
    logger: log.logger,
    settings: SETTINGS,
  });
  return { verifier, calls, log, state };
}

async function watch(...locations: (typeof CHENNAI)[]) {
  await repo.syncCells(groupByCell(locations), WATCHED_SINCE);
}

function event(
  hazard: string,
  windowStart: string,
  windowEnd: string,
  tripwire: Tripwire | null,
  options: { cellId?: string; level?: MonitorLevel } = {},
) {
  return prisma.disasterEvent.create({
    data: {
      cellId: options.cellId ?? CHENNAI_CELL,
      hazard,
      level: options.level ?? "WATCH",
      windowStart: new Date(`${windowStart}T00:00:00Z`),
      windowEnd: new Date(`${windowEnd}T00:00:00Z`),
      forecastValues: { tripwire, rain_mm: 90 },
      evidence: "fixture",
      sourceRunId: "mon-2026-10-09T11:30",
    },
  });
}

const stored = () => prisma.disasterEvent.findMany({ orderBy: { eventId: "asc" } });

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE disaster_events, monitored_cells RESTART IDENTITY`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("labelling pending events", () => {
  it("marks an event a hit when the observed value crossed its tripwire", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    const { verifier } = setup({ weather: { precipitation_sum: { "2026-10-12": 88 } } });

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 1, falseAlarm: 0, missed: 0, waiting: 0, failed: 0 });
    expect((await stored())[0]).toMatchObject({
      status: "hit",
      verifiedAt: NOW,
      observedValues: {
        variable: "precipitation_sum",
        threshold: 64.5,
        peak: 88,
        peakDate: "2026-10-12",
        crossed: true,
      },
      // The forecast numbers stay next to the observed ones
      forecastValues: { rain_mm: 90, tripwire: RAIN },
    });
  });

  it("marks an event a false alarm when it did not", async () => {
    await watch(CHENNAI);
    await event("heat", "2026-10-10", "2026-10-11", HEAT);
    const { verifier } = setup({ weather: { temperature_2m_max: { "2026-10-10": 38 } } });

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 0, falseAlarm: 1 });
    expect((await stored())[0]).toMatchObject({
      status: "false_alarm",
      observedValues: { peak: 38, crossed: false },
    });
  });

  it("leaves an event alone until its window ended at least 5 days ago", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-15", "2026-10-16", RAIN);
    const { verifier } = setup();

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 0, falseAlarm: 0, waiting: 0 });
    expect((await stored())[0]).toMatchObject({ status: "pending", verifiedAt: null });
  });

  it("labels an event whose window ended exactly 5 days ago", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-14", "2026-10-15", RAIN);
    const { verifier } = setup();

    await verifier.run();

    expect((await stored())[0]?.status).toBe("false_alarm");
  });

  it("keeps an event pending while its observed data is incomplete", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    const { verifier } = setup({ weather: { precipitation_sum: { "2026-10-12": null } } });

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 0, falseAlarm: 0, waiting: 1 });
    expect((await stored())[0]?.status).toBe("pending");
  });

  it("labels an agent-raised event with no tripwire against the hazard's lowest one", async () => {
    await watch(CHENNAI);
    await event("heat", "2026-10-10", "2026-10-11", null);
    const { verifier } = setup({ weather: { temperature_2m_max: { "2026-10-11": 41 } } });

    await verifier.run();

    expect((await stored())[0]).toMatchObject({
      status: "hit",
      observedValues: { variable: "temperature_2m_max", threshold: 40, peak: 41 },
    });
  });

  it("checks a river event against observed discharge", async () => {
    await watch(CHENNAI);
    await event("river_flood", "2026-10-10", "2026-10-12", DISCHARGE, { level: "WARNING" });
    const { verifier, calls, state } = setup({ river: { river_discharge: { "2026-10-11": 1240 } } });
    state.river = RIVER;

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 1, missed: 0 });
    expect(calls.map((call) => call.api)).toEqual(["archive", "flood_history"]);
    expect((await stored())[0]).toMatchObject({ status: "hit", observedValues: { peak: 1240 } });
  });

  it("still labels the events of a cell that is no longer watched", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    await repo.syncCells([], NOW);
    const { verifier } = setup({
      weather: { precipitation_sum: { "2026-10-11": 90 }, wind_gusts_10m_max: { "2026-10-14": 99 } },
    });

    const summary = await verifier.run();

    // Labelled, but an unwatched cell is not scanned for missed extremes
    expect(summary).toMatchObject({ hit: 1, missed: 0 });
  });

  it("does nothing on a second run", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    const { verifier } = setup({ weather: { precipitation_sum: { "2026-10-12": 88 } } });
    await verifier.run();

    const again = await verifier.run();

    expect(again).toMatchObject({ hit: 0, falseAlarm: 0, missed: 0 });
    expect(await prisma.disasterEvent.count()).toBe(1);
  });
});

describe("finding missed extremes", () => {
  it("records an observed extreme that had no forecast event", async () => {
    await watch(CHENNAI);
    const { verifier } = setup({ weather: { wind_gusts_10m_max: { "2026-10-13": 78 } } });

    const summary = await verifier.run();

    expect(summary).toMatchObject({ missed: 1 });
    const [missed] = await stored();
    expect(missed).toMatchObject({
      cellId: CHENNAI_CELL,
      hazard: "storm",
      level: "WATCH",
      status: "missed",
      sourceRunId: null,
      verifiedAt: NOW,
      evidence: "Observed wind_gusts_10m_max of 78 on 13 Oct crossed 60 with no forecast event",
      observedValues: { variable: "wind_gusts_10m_max", peak: 78, peakDate: "2026-10-13", crossed: true },
      forecastValues: { tripwire: { variable: "wind_gusts_10m_max", threshold: 60, direction: "above" } },
    });
    expect(missed?.windowStart.toISOString().slice(0, 10)).toBe("2026-10-13");
  });

  it("does not call an extreme missed when an event forecast it", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    const { verifier } = setup({ weather: { precipitation_sum: { "2026-10-12": 88 } } });

    expect(await verifier.run()).toMatchObject({ hit: 1, missed: 0 });
  });

  it("does not record the same missed extreme twice", async () => {
    await watch(CHENNAI);
    const { verifier } = setup({ weather: { precipitation_sum: { "2026-10-13": 95 } } });
    await verifier.run();

    const again = await verifier.run();

    expect(again.missed).toBe(0);
    expect(await prisma.disasterEvent.count({ where: { status: "missed" } })).toBe(1);
  });

  it("scans the last 7 observed days, in one archive call per cell", async () => {
    await watch(CHENNAI);
    const { verifier, calls } = setup();

    await verifier.run();

    expect(calls).toEqual([{ api: "archive", lat: 13.1, start: "2026-10-09", end: "2026-10-15" }]);
  });

  it("widens the call to cover an older pending event", async () => {
    await watch(CHENNAI);
    await event("heat", "2026-10-05", "2026-10-06", HEAT);
    const { verifier, calls } = setup();

    await verifier.run();

    expect(calls[0]).toMatchObject({ start: "2026-10-05", end: "2026-10-15" });
  });

  it("does not scan days before the cell was watched", async () => {
    await repo.syncCells(groupByCell([CHENNAI]), new Date("2026-10-13T06:00:00Z"));
    const { verifier, calls } = setup({ weather: { precipitation_sum: { "2026-10-10": 120 } } });

    const summary = await verifier.run();

    expect(calls[0]).toMatchObject({ start: "2026-10-13" });
    expect(summary.missed).toBe(0);
  });

  it("finds a river above its historical high that nothing forecast", async () => {
    await watch(CHENNAI);
    const { verifier, state } = setup({ river: { river_discharge: { "2026-10-12": 1300 } } });
    state.river = RIVER;

    await verifier.run();

    expect(await stored()).toMatchObject([
      { hazard: "river_flood", level: "WARNING", status: "missed", observedValues: { peak: 1300 } },
    ]);
  });
});

describe("failures", () => {
  it("skips a cell whose observed data cannot be fetched and verifies the rest", async () => {
    await watch(CHENNAI, PUNE);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    await event("heat", "2026-10-10", "2026-10-11", HEAT, { cellId: PUNE_CELL });
    const { verifier, state, log } = setup();
    state.archiveDownAt = 13.1;

    const summary = await verifier.run();

    expect(summary).toMatchObject({ failed: 1, falseAlarm: 1 });
    expect((await stored()).map((e) => [e.cellId, e.status])).toEqual([
      [CHENNAI_CELL, "pending"],
      [PUNE_CELL, "false_alarm"],
    ]);
    expect(log.of("warn")[0]).toContain("0.1:13.1:80.3: verification failed");
  });

  it("still labels weather events when the river history is unavailable", async () => {
    await watch(CHENNAI);
    await event("flash_flood", "2026-10-11", "2026-10-12", RAIN);
    await event("river_flood", "2026-10-11", "2026-10-12", DISCHARGE, { level: "WARNING" });
    const { verifier, state, log } = setup({ weather: { precipitation_sum: { "2026-10-11": 90 } } });
    state.river = RIVER;
    state.riverDown = true;

    const summary = await verifier.run();

    expect(summary).toMatchObject({ hit: 1, waiting: 1, failed: 0 });
    expect((await stored()).map((e) => [e.hazard, e.status])).toEqual([
      ["flash_flood", "hit"],
      ["river_flood", "pending"],
    ]);
    expect(log.of("warn")[0]).toContain("observed river discharge unavailable");
  });
});
