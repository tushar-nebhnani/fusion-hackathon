import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectDb, prisma } from "../../../config/db.js";
import { AppError } from "../../../errors/app-error.js";
import { FakeClock } from "./adapters/clock.js";
import { loadMonitorConfig, type MonitorConfig } from "./config.js";
import type { WatchedLocation } from "./ports.js";
import { createMonitorRepo } from "./repo.js";
import {
  CHENNAI,
  CHENNAI_CELL,
  CHENNAI_NEIGHBOUR,
  HOUR_MS,
  PUNE,
  PUNE_CELL,
  START,
  detailedOf,
  memoryLogger,
  never,
  recordingSink,
  stubClimate,
  type DetailScript,
} from "./testing/fixtures.js";
import { createMonitor } from "./tick.js";

// The monitor against the real test database, with the climate unit's entry
// function, the alert sink and the clock replaced
const repo = createMonitorRepo(prisma);
const HEAVY_RAIN: DetailScript = { weather: { rain: [0, 130, 90] } };
const CALM: DetailScript = {};

function setup(overrides: Partial<MonitorConfig> = {}, watched: WatchedLocation[] = [CHENNAI, PUNE]) {
  const clock = new FakeClock(START);
  const config: MonitorConfig = { ...loadMonitorConfig({}), ...overrides };
  const stub = stubClimate();
  const alerts = recordingSink();
  const log = memoryLogger();
  const state = { locations: watched, listed: 0, sourceDown: false };
  const source = {
    list() {
      state.listed += 1;
      if (state.sourceDown) return Promise.reject(new Error("loans DB is down"));
      return Promise.resolve(state.locations);
    },
  };
  const monitor = (instanceId = "monitor-a") =>
    createMonitor({
      config,
      climate: stub.climate,
      source,
      sink: alerts.sink,
      logger: log.logger,
      clock,
      repo,
      instanceId,
    });
  const cell = async (cellId: string) => {
    const found = await repo.getCell(cellId);
    if (!found) throw new Error(`no cell ${cellId}`);
    return found;
  };
  return { clock, config, stub, alerts, log, state, monitor, cell };
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE disaster_events, monitored_cells RESTART IDENTITY`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("cells", () => {
  it("starts a new cell at NORMAL and checks it at once", async () => {
    const { monitor, cell, stub } = setup();

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 2, checked: 2, failed: 0, suddenChanges: 0, alerts: 0 });
    expect(stub.calls).toHaveLength(2);
    expect(await cell(CHENNAI_CELL)).toMatchObject({
      active: true,
      level: "NORMAL",
      calmRuns: 0,
      lat: CHENNAI.lat,
      lon: CHENNAI.lon,
      lastCheckedAt: START,
      nextCheckAt: new Date(START.getTime() + 6 * HOUR_MS),
    });
  });

  it("calls the entry function once for two locations in one cell, and alerts both", async () => {
    const { monitor, stub, alerts } = setup({}, [CHENNAI, CHENNAI_NEIGHBOUR]);
    stub.state.script = HEAVY_RAIN;

    const summary = await monitor().tick();

    expect(stub.calls).toHaveLength(1);
    expect(summary).toMatchObject({ due: 1, checked: 1, suddenChanges: 1, alerts: 2 });
    expect(alerts.events).toEqual([
      {
        businessId: "SME-0142",
        hazard: "flash_flood",
        severity: "WARNING",
        windowStart: "2026-10-10",
        windowEnd: "2026-10-11",
        evidence: "130 mm rain forecast on 10 Oct, 80% probability",
        sourceRunId: "mon-2026-10-09T11:30",
      },
      { ...alerts.events[0], businessId: "SME-0143" },
    ]);
  });

  it("asks for a fresh forecast, at the cell's first location, as the monitor", async () => {
    const { monitor, stub } = setup({}, [CHENNAI_NEIGHBOUR, CHENNAI]);

    await monitor().tick();

    expect(stub.calls).toEqual([
      {
        point: { lat: CHENNAI.lat, lon: CHENNAI.lon },
        requesterId: "climate-monitor",
        options: { forceFreshForecast: true },
      },
    ]);
  });

  it("leaves a cell alone until it is due", async () => {
    const { monitor, stub, clock } = setup();
    await monitor().tick();
    stub.calls.length = 0;

    clock.advanceHours(5.75);
    expect(await monitor().tick()).toMatchObject({ due: 0, checked: 0 });
    expect(stub.calls).toEqual([]);

    clock.advanceHours(0.25);
    expect(await monitor().tick()).toMatchObject({ due: 2, checked: 2 });
  });

  it("switches off a cell with no locations left, and never checks it", async () => {
    const { monitor, stub, state, clock, cell } = setup();
    await monitor().tick();
    stub.calls.length = 0;

    state.locations = [PUNE];
    clock.advanceHours(6);
    await monitor().tick();

    expect((await cell(CHENNAI_CELL)).active).toBe(false);
    expect(stub.calls.map((call) => call.point)).toEqual([{ lat: PUNE.lat, lon: PUNE.lon }]);
  });

  it("starts a cell afresh when it is watched again", async () => {
    const { monitor, stub, state, clock, cell } = setup();
    stub.state.script = HEAVY_RAIN;
    await monitor().tick();
    expect((await cell(CHENNAI_CELL)).level).toBe("WARNING");

    state.locations = [PUNE];
    clock.advanceHours(1);
    await monitor().tick();
    state.locations = [CHENNAI, PUNE];
    stub.state.script = CALM;
    clock.advanceHours(1);
    await monitor().tick();

    expect(await cell(CHENNAI_CELL)).toMatchObject({ active: true, level: "NORMAL", calmRuns: 0 });
  });

  it("leaves every cell as it is when the location source fails", async () => {
    const { monitor, state, clock, cell } = setup();
    await monitor().tick();

    state.sourceDown = true;
    clock.advanceHours(6);
    await expect(monitor().tick()).rejects.toThrow("loans DB is down");

    expect((await cell(CHENNAI_CELL)).active).toBe(true);
    expect((await cell(PUNE_CELL)).active).toBe(true);
  });
});

describe("sudden change", () => {
  it("escalates the cell, alerts and records a pending disaster event", async () => {
    const { monitor, stub, clock, cell, alerts } = setup({}, [CHENNAI]);
    await monitor().tick();

    stub.state.script = HEAVY_RAIN;
    clock.advanceHours(6);
    const at = clock.now();
    const summary = await monitor().tick();

    expect(summary).toMatchObject({ checked: 1, suddenChanges: 1, alerts: 1 });
    expect(await cell(CHENNAI_CELL)).toMatchObject({
      level: "WARNING",
      calmRuns: 0,
      // WARNING is checked hourly
      nextCheckAt: new Date(at.getTime() + HOUR_MS),
    });
    expect(alerts.events).toHaveLength(1);

    const events = await prisma.disasterEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cellId: CHENNAI_CELL,
      hazard: "flash_flood",
      level: "WARNING",
      status: "pending",
      evidence: "130 mm rain forecast on 10 Oct, 80% probability",
      sourceRunId: "mon-2026-10-09T17:30",
      observedValues: null,
      verifiedAt: null,
      createdAt: at,
    });
    expect(events[0]?.windowStart.toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(events[0]?.forecastValues).toMatchObject({
      rain_mm: 130,
      rain_probability_pct: 80,
      tripwire: { variable: "precipitation_sum", threshold: 115.6, direction: "above" },
      source: "rules",
      dormant: false,
      cell: { rainMaxMm: 130, tmaxC: 30 },
    });
  });

  it("maps SEVERE to a CRITICAL alert", async () => {
    const { monitor, stub, alerts } = setup({}, [CHENNAI]);
    stub.state.script = { weather: { rain: [210] } };

    await monitor().tick();

    expect(alerts.events[0]?.severity).toBe("CRITICAL");
  });

  it("alerts once while the hazard stays at the same level", async () => {
    const { monitor, stub, clock, alerts } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    await monitor().tick();

    for (let hour = 0; hour < 3; hour++) {
      clock.advanceHours(1);
      await monitor().tick();
    }

    expect(alerts.events).toHaveLength(1);
    expect(await prisma.disasterEvent.count()).toBe(1);
  });

  it("alerts again when the hazard rises further", async () => {
    const { monitor, stub, clock, alerts, cell } = setup({}, [CHENNAI]);
    stub.state.script = { weather: { rain: [0, 90] } };
    await monitor().tick();
    expect((await cell(CHENNAI_CELL)).level).toBe("WATCH");

    stub.state.script = HEAVY_RAIN;
    clock.advanceHours(3);
    await monitor().tick();

    expect(alerts.events.map((event) => event.severity)).toEqual(["WATCH", "WARNING"]);
    expect((await cell(CHENNAI_CELL)).level).toBe("WARNING");
  });

  it("steps down one level only after two calm checks in a row", async () => {
    const { monitor, stub, clock, cell } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    await monitor().tick();

    stub.state.script = CALM;
    clock.advanceHours(1);
    await monitor().tick();
    expect(await cell(CHENNAI_CELL)).toMatchObject({ level: "WARNING", calmRuns: 1 });

    clock.advanceHours(1);
    const at = clock.now();
    await monitor().tick();
    expect(await cell(CHENNAI_CELL)).toMatchObject({
      level: "WATCH",
      calmRuns: 0,
      nextCheckAt: new Date(at.getTime() + 3 * HOUR_MS),
    });
  });

  it("stores the snapshot the next check compares against", async () => {
    const { monitor, stub, cell } = setup({}, [CHENNAI]);
    stub.state.script = { weather: { tmax: [41] } };

    await monitor().tick();

    expect((await cell(CHENNAI_CELL)).lastSnapshot).toMatchObject({
      at: START.toISOString(),
      levels: { heat: "WATCH", flash_flood: "NORMAL" },
      values: { tmaxC: 41 },
    });
  });
});

describe("isolation", () => {
  // A cell that has been checked before uses the short entry timeout
  async function checkedOnce(overrides: Partial<MonitorConfig> = {}) {
    const context = setup({ entryTimeoutMs: 30, firstCheckTimeoutMs: 30, ...overrides });
    await context.monitor().tick();
    context.stub.calls.length = 0;
    context.clock.advanceHours(6);
    return context;
  }
  const isChennai = (point: { lat: number }) => point.lat === CHENNAI.lat;

  it("carries on with the other cells when one times out", async () => {
    const { monitor, stub, cell, clock, log } = await checkedOnce();
    stub.state.respond = (point) => (isChennai(point) ? never() : undefined);

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 2, checked: 1, failed: 1 });
    expect((await cell(PUNE_CELL)).lastCheckedAt).toEqual(clock.now());
    expect(log.of("warn")[0]).toMatch(/0\.1:13\.1:80\.3: check failed, state kept, retried next tick: .*timed out after 30 ms/);
  });

  it("keeps a failed cell's state and checks it again on the next tick", async () => {
    const { monitor, stub, cell, clock } = await checkedOnce();
    const before = await cell(CHENNAI_CELL);
    stub.state.respond = (point) => (isChennai(point) ? never() : undefined);
    await monitor().tick();

    expect(await cell(CHENNAI_CELL)).toEqual(before);

    stub.state.respond = null;
    clock.advance(15 * 60_000);
    expect(await monitor().tick()).toMatchObject({ due: 1, checked: 1, failed: 0 });
    expect((await cell(CHENNAI_CELL)).lastCheckedAt).toEqual(clock.now());
  });

  it("does not let one failing new cell hold back the others", async () => {
    const { monitor, stub, cell } = setup({ firstCheckTimeoutMs: 30 });
    stub.state.respond = (point) => (isChennai(point) ? never() : undefined);

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 2, checked: 1, failed: 1 });
    expect((await cell(PUNE_CELL)).lastCheckedAt).toEqual(START);
    expect((await cell(CHENNAI_CELL)).lastCheckedAt).toBeNull();
  });

  it("reports a climate unit error with its code and pipeline step", async () => {
    const { monitor, stub, log } = setup({}, [CHENNAI]);
    stub.state.respond = () =>
      Promise.reject(
        new AppError(
          "Climate data sources are unavailable",
          503,
          "UPSTREAM_UNAVAILABLE",
          undefined,
          "fetch_screening",
        ),
      );

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ checked: 0, failed: 1 });
    expect(log.of("warn")[0]).toContain(
      "UPSTREAM_UNAVAILABLE at fetch_screening: Climate data sources are unavailable",
    );
  });

  it("treats a missing weather forecast as a failed check, not a calm one", async () => {
    const { monitor, stub, clock, cell } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    await monitor().tick();

    stub.state.script = { weather: null };
    clock.advanceHours(1);
    const summary = await monitor().tick();

    expect(summary).toMatchObject({ checked: 0, failed: 1 });
    expect(await cell(CHENNAI_CELL)).toMatchObject({ level: "WARNING", calmRuns: 0 });
  });

  it("does not throw when enqueue() resolves to false", async () => {
    const { monitor, stub, alerts, cell, log } = setup({}, [CHENNAI, CHENNAI_NEIGHBOUR]);
    stub.state.script = HEAVY_RAIN;
    alerts.state.answer = false;

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ checked: 1, failed: 0, alerts: 2 });
    expect((await cell(CHENNAI_CELL)).level).toBe("WARNING");
    expect(await prisma.disasterEvent.count()).toBe(1);
    expect(log.of("warn")).toEqual([
      "2 of 2 alerts for 0.1:13.1:80.3 were not accepted by the alert sink",
    ]);
  });

  it("does not throw when the alert sink itself throws", async () => {
    const { monitor, stub, alerts, cell } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    alerts.state.answer = "throw";

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ checked: 1, failed: 0 });
    expect((await cell(CHENNAI_CELL)).level).toBe("WARNING");
  });

  it("makes no call at all when MONITOR_ENABLED is false", async () => {
    const { monitor, stub, state, alerts } = setup({ enabled: false });
    stub.state.script = HEAVY_RAIN;

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 0, checked: 0, alerts: 0 });
    expect(state.listed).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(alerts.events).toEqual([]);
    expect(await prisma.monitoredCell.count()).toBe(0);
  });

  it("checks no more cells at once than the configured limit", async () => {
    const many: WatchedLocation[] = Array.from({ length: 8 }, (_, i) => ({
      locationId: `M${i}`,
      businessId: `SME-9${i}`,
      lat: 20 + i,
      lon: 78,
    }));
    const { monitor, stub, clock } = setup({ concurrency: 3 }, many);
    await monitor().tick();
    clock.advanceHours(6);

    let running = 0;
    let most = 0;
    stub.state.respond = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return detailedOf();
    };
    const summary = await monitor().tick();

    expect(summary.checked).toBe(8);
    expect(most).toBe(3);
  });

  it("starts no new cell once it is told to stop, and hands back its leases", async () => {
    // One cell at a time, so the second has not started when the stop arrives
    const { monitor, stub, clock } = await checkedOnce({ concurrency: 1 });
    const instance = monitor();
    stub.state.respond = async () => {
      // Shutdown arrives while the first cell is being checked
      instance.stop();
      await Promise.resolve();
      return detailedOf();
    };

    const summary = await instance.tick();
    await instance.release();

    // The cell in progress is finished; the other is left for the next run
    expect(stub.calls).toHaveLength(1);
    expect(summary).toMatchObject({ due: 2, checked: 1, deferred: 1, failed: 0 });
    expect(await prisma.monitoredCell.count({ where: { lockedBy: { not: null } } })).toBe(0);
    expect(await instance.tick()).toMatchObject({ checked: 0 });
    expect(clock.now()).toEqual(new Date(START.getTime() + 6 * HOUR_MS));
  });
});

describe("restart and leases", () => {
  it("picks up level, calm count and schedule from the database after a restart", async () => {
    const { monitor, stub, clock, cell } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    await monitor("before-restart").tick();
    stub.state.script = CALM;
    clock.advanceHours(1);
    await monitor("before-restart").tick();
    expect(await cell(CHENNAI_CELL)).toMatchObject({ level: "WARNING", calmRuns: 1 });

    // A new process: nothing is carried over in memory
    const restarted = monitor("after-restart");
    stub.calls.length = 0;
    expect(await restarted.tick()).toMatchObject({ due: 0, checked: 0 });
    expect(stub.calls).toEqual([]);

    clock.advanceHours(1);
    await restarted.tick();
    expect(await cell(CHENNAI_CELL)).toMatchObject({ level: "WATCH", calmRuns: 0 });
  });

  it("does not alert again after a restart for a change it already reported", async () => {
    const { monitor, stub, clock, alerts } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    await monitor("before-restart").tick();

    clock.advanceHours(1);
    await monitor("after-restart").tick();

    expect(alerts.events).toHaveLength(1);
  });

  it("never checks a cell twice in one tick, even with two monitors running", async () => {
    const { monitor, stub } = setup();

    const [a, b] = await Promise.all([monitor("monitor-a").tick(), monitor("monitor-b").tick()]);

    expect(stub.calls).toHaveLength(2);
    expect(a.checked + b.checked).toBe(2);
    expect(a.failed + b.failed).toBe(0);
  });

  it("skips a cell another monitor holds a lease on", async () => {
    const { monitor, stub, clock } = setup();
    await monitor().tick();
    stub.calls.length = 0;
    clock.advanceHours(6);
    await prisma.monitoredCell.update({
      where: { cellId: CHENNAI_CELL },
      data: { lockedBy: "monitor-dead", lockUntil: new Date(clock.now().getTime() + 5 * 60_000) },
    });

    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 1, checked: 1 });
    expect(stub.calls.map((call) => call.point.lat)).toEqual([PUNE.lat]);
  });

  it("reclaims a lease once it has expired", async () => {
    const { monitor, stub, clock, cell } = setup({}, [CHENNAI]);
    await monitor().tick();
    stub.calls.length = 0;
    clock.advanceHours(6);
    await prisma.monitoredCell.update({
      where: { cellId: CHENNAI_CELL },
      data: { lockedBy: "monitor-dead", lockUntil: new Date(clock.now().getTime() + 5 * 60_000) },
    });
    expect(await monitor().tick()).toMatchObject({ due: 0, checked: 0 });

    clock.advance(5 * 60_000);
    const summary = await monitor().tick();

    expect(summary).toMatchObject({ due: 1, checked: 1 });
    const row = await prisma.monitoredCell.findUniqueOrThrow({ where: { cellId: CHENNAI_CELL } });
    expect(row).toMatchObject({ lockedBy: null, lockUntil: null });
    expect((await cell(CHENNAI_CELL)).lastCheckedAt).toEqual(clock.now());
  });

  it("holds the lease while a cell is being checked and frees it afterwards", async () => {
    const { monitor, stub, clock } = setup({ leaseSeconds: 300 }, [CHENNAI]);
    let during: { lockedBy: string | null; lockUntil: Date | null } | null = null;
    stub.state.respond = async () => {
      during = await prisma.monitoredCell.findUniqueOrThrow({
        where: { cellId: CHENNAI_CELL },
        select: { lockedBy: true, lockUntil: true },
      });
      return detailedOf();
    };

    await monitor("monitor-a").tick();

    expect(during).toEqual({
      lockedBy: "monitor-a",
      lockUntil: new Date(clock.now().getTime() + 300_000),
    });
    const after = await prisma.monitoredCell.findUniqueOrThrow({ where: { cellId: CHENNAI_CELL } });
    expect(after.lockedBy).toBeNull();
  });

  it("discards a check whose lease was taken over meanwhile", async () => {
    const { monitor, stub, cell, alerts } = setup({}, [CHENNAI]);
    stub.state.script = HEAVY_RAIN;
    stub.state.respond = async () => {
      await prisma.monitoredCell.update({
        where: { cellId: CHENNAI_CELL },
        data: { lockedBy: "monitor-b" },
      });
      return detailedOf(HEAVY_RAIN);
    };

    const summary = await monitor("monitor-a").tick();

    expect(summary).toMatchObject({ checked: 0, failed: 1 });
    // The other monitor's lease and the cell's state are untouched
    const row = await prisma.monitoredCell.findUniqueOrThrow({ where: { cellId: CHENNAI_CELL } });
    expect(row.lockedBy).toBe("monitor-b");
    expect((await cell(CHENNAI_CELL)).level).toBe("NORMAL");
    expect(await prisma.disasterEvent.count()).toBe(0);
    // The alert went out before the save; the alert system drops the repeat
    expect(alerts.events).toHaveLength(1);
  });
});
