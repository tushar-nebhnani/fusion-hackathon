import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createJsonLocationSource, parseLocation } from "./adapters/jsonLocationSource.js";
import { groupByCell } from "./cells.js";
import { loadMonitorConfig } from "./config.js";
import { memoryLogger } from "./testing/fixtures.js";

describe("loadMonitorConfig", () => {
  it("uses the defaults when nothing is set", () => {
    expect(loadMonitorConfig({})).toMatchObject({
      enabled: true,
      tickMinutes: 15,
      concurrency: 5,
      agentEnabled: false,
      locationSource: "input",
      locationsFile: "data/monitor-locations.json",
      alertSink: "outbox",
      intervalHours: { NORMAL: 6, WATCH: 3, WARNING: 1, SEVERE: 1 },
      entryTimeoutMs: 15_000,
      agentTimeoutMs: 20_000,
    });
  });

  it("reads the MONITOR_* settings", () => {
    const config = loadMonitorConfig({
      MONITOR_ENABLED: "false",
      MONITOR_TICK_MINUTES: "5",
      MONITOR_CONCURRENCY: "2",
      MONITOR_AGENT_ENABLED: "true",
      MONITOR_LOCATION_SOURCE: "json",
      MONITOR_LOCATIONS_FILE: "data/other.json",
      MONITOR_ALERT_SINK: "console",
    });

    expect(config).toMatchObject({
      enabled: false,
      tickMinutes: 5,
      concurrency: 2,
      agentEnabled: true,
      locationSource: "json",
      locationsFile: "data/other.json",
      alertSink: "console",
    });
  });

  it("falls back to the default for an invalid value instead of failing", () => {
    const config = loadMonitorConfig({
      MONITOR_ENABLED: "yes",
      MONITOR_TICK_MINUTES: "soon",
      MONITOR_CONCURRENCY: "0",
      MONITOR_ALERT_SINK: "sms",
    });

    expect(config).toMatchObject({ enabled: true, tickMinutes: 15, concurrency: 5, alertSink: "outbox" });
  });
});

describe("watched locations file", () => {
  it("accepts a location and rounds it like the API does", () => {
    expect(
      parseLocation({ locationId: "L1", businessId: "SME-0142", lat: 13.08271234, lon: 80.2707, label: "Bakery" }),
    ).toEqual({ locationId: "L1", businessId: "SME-0142", lat: 13.0827, lon: 80.2707, label: "Bakery" });
  });

  it("rejects a location outside the climate unit's coverage", () => {
    expect(() => parseLocation({ locationId: "X", businessId: "B", lat: 51.5, lon: -0.12 })).toThrow(
      /outside the supported coverage/,
    );
  });

  it("skips a bad entry with a warning and keeps the rest", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "monitor-")), "locations.json");
    await writeFile(
      path,
      JSON.stringify([
        { locationId: "L1", businessId: "SME-1", lat: 13.0827, lon: 80.2707 },
        { locationId: "L2", businessId: "SME-2", lat: "north", lon: 80 },
        { locationId: "L3", lat: 18.5, lon: 73.8 },
      ]),
    );
    const log = memoryLogger();

    const locations = await createJsonLocationSource(path, log.logger).list();

    expect(locations.map((l) => l.locationId)).toEqual(["L1"]);
    expect(log.of("warn")).toHaveLength(2);
  });

  it("fails when the file is not a list", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "monitor-")), "locations.json");
    await writeFile(path, JSON.stringify({ locations: [] }));

    await expect(createJsonLocationSource(path, memoryLogger().logger).list()).rejects.toThrow(
      /JSON array/,
    );
  });

  it("ships 8 valid Indian locations, two of them in one cell", async () => {
    const log = memoryLogger();
    const locations = await createJsonLocationSource(
      resolve("data/monitor-locations.json"),
      log.logger,
    ).list();

    expect(locations).toHaveLength(8);
    expect(log.lines).toEqual([]);
    const groups = groupByCell(locations);
    expect(groups).toHaveLength(7);
    expect(groups.find((g) => g.locations.length === 2)?.locations.map((l) => l.locationId)).toEqual([
      "L1",
      "L2",
    ]);
  });
});
