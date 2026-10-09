import { describe, expect, it } from "vitest";
import type { TimeSeries } from "../types.js";
import { baseTripwires } from "./rules.js";
import { RIVER, SETTINGS } from "./testing/fixtures.js";
import type { Tripwire } from "./types.js";
import { findMissed, labelEvent } from "./verify.js";

const RAIN: Tripwire = { variable: "precipitation_sum", threshold: 64.5, direction: "above" };
const COLD: Tripwire = { variable: "temperature_2m_min", threshold: 4, direction: "below" };

// Observed days from 1 Oct 2026
function observed(values: Record<string, (number | null)[]>): TimeSeries {
  const length = Math.max(...Object.values(values).map((list) => list.length));
  return {
    time: Array.from({ length }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`),
    values,
  };
}

describe("labelEvent", () => {
  const event = { windowStart: "2026-10-02", windowEnd: "2026-10-03" };

  it("is a hit when the observed value crossed the same tripwire", () => {
    const label = labelEvent(event, RAIN, observed({ precipitation_sum: [0, 20, 88, 0] }));

    expect(label).toEqual({
      status: "hit",
      observed: {
        variable: "precipitation_sum",
        threshold: 64.5,
        direction: "above",
        peak: 88,
        peakDate: "2026-10-03",
        crossed: true,
      },
    });
  });

  it("is a false alarm when it did not", () => {
    const label = labelEvent(event, RAIN, observed({ precipitation_sum: [0, 20, 40, 0] }));

    expect(label).toMatchObject({ status: "false_alarm", observed: { peak: 40, crossed: false } });
  });

  it("only looks inside the event's window", () => {
    // 90 mm fell the day after the window closed
    const label = labelEvent(event, RAIN, observed({ precipitation_sum: [0, 10, 10, 90] }));

    expect(label?.status).toBe("false_alarm");
  });

  it("counts a value exactly on the tripwire as crossing it", () => {
    expect(labelEvent(event, RAIN, observed({ precipitation_sum: [0, 64.5, 0] }))?.status).toBe("hit");
  });

  it("handles a tripwire that is crossed downwards", () => {
    expect(labelEvent(event, COLD, observed({ temperature_2m_min: [9, 3, 6] }))).toMatchObject({
      status: "hit",
      observed: { peak: 3, peakDate: "2026-10-02" },
    });
    expect(labelEvent(event, COLD, observed({ temperature_2m_min: [9, 5, 6] }))?.status).toBe(
      "false_alarm",
    );
  });

  it("waits while a day of the window is still missing", () => {
    expect(labelEvent(event, RAIN, observed({ precipitation_sum: [0, 20, null] }))).toBeNull();
    expect(labelEvent(event, RAIN, observed({ precipitation_sum: [0, 20] }))).toBeNull();
  });

  it("does not wait once a crossing is already on record", () => {
    expect(labelEvent(event, RAIN, observed({ precipitation_sum: [0, 90, null] }))?.status).toBe("hit");
  });

  it("waits when there is no observed data at all", () => {
    expect(labelEvent(event, RAIN, null)).toBeNull();
    expect(labelEvent(event, RAIN, observed({ temperature_2m_max: [30, 30, 30] }))).toBeNull();
  });
});

describe("findMissed", () => {
  const scan = (
    weather: Record<string, (number | null)[]>,
    events: { hazard: string; windowStart: string; windowEnd: string }[] = [],
    river: TimeSeries | null = null,
  ) =>
    findMissed({
      tripwires: baseTripwires(river ? RIVER : null, SETTINGS),
      weather: observed(weather),
      river,
      from: "2026-10-01",
      to: "2026-10-07",
      events,
      toleranceDays: 2,
    });

  it("finds an observed extreme that nothing forecast", () => {
    const missed = scan({ precipitation_sum: [0, 0, 0, 92, 0, 0, 0] });

    expect(missed).toEqual([
      {
        hazard: "flash_flood",
        level: "WATCH",
        windowStart: "2026-10-04",
        windowEnd: "2026-10-04",
        observed: {
          variable: "precipitation_sum",
          threshold: 64.5,
          direction: "above",
          peak: 92,
          peakDate: "2026-10-04",
          crossed: true,
        },
      },
    ]);
  });

  it("reports nothing when the extreme was forecast", () => {
    const events = [{ hazard: "flash_flood", windowStart: "2026-10-04", windowEnd: "2026-10-05" }];

    expect(scan({ precipitation_sum: [0, 0, 0, 92, 0, 0, 0] }, events)).toEqual([]);
  });

  it("accepts a forecast that was up to two days off", () => {
    const early = [{ hazard: "flash_flood", windowStart: "2026-10-01", windowEnd: "2026-10-02" }];
    const tooEarly = [{ hazard: "flash_flood", windowStart: "2026-10-01", windowEnd: "2026-10-01" }];

    expect(scan({ precipitation_sum: [0, 0, 0, 92] }, early)).toEqual([]);
    expect(scan({ precipitation_sum: [0, 0, 0, 92] }, tooEarly)).toHaveLength(1);
  });

  it("does not let an event for another hazard explain it", () => {
    const events = [{ hazard: "heat", windowStart: "2026-10-04", windowEnd: "2026-10-04" }];

    expect(scan({ precipitation_sum: [0, 0, 0, 92] }, events)).toHaveLength(1);
  });

  it("joins consecutive days into one run with its peak", () => {
    const missed = scan({ temperature_2m_max: [38, 41, 44, 42, 39, 30, 30] });

    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({
      hazard: "heat",
      windowStart: "2026-10-02",
      windowEnd: "2026-10-04",
      observed: { peak: 44, peakDate: "2026-10-03" },
    });
  });

  it("keeps separate runs separate", () => {
    const missed = scan({ wind_gusts_10m_max: [70, 20, 20, 20, 95, 20, 20] });

    expect(missed.map((m) => [m.hazard, m.windowStart, m.observed.peak])).toEqual([
      ["storm", "2026-10-01", 70],
      ["storm", "2026-10-05", 95],
    ]);
  });

  it("treats a missing day as a break, not as a crossing", () => {
    const missed = scan({ temperature_2m_max: [41, null, 41, 30] });

    expect(missed.map((m) => m.windowStart)).toEqual(["2026-10-01", "2026-10-03"]);
  });

  it("ignores days outside the scanned period", () => {
    const missed = findMissed({
      tripwires: baseTripwires(null, SETTINGS),
      weather: observed({ precipitation_sum: [92, 0, 0, 0, 0, 0, 92] }),
      river: null,
      from: "2026-10-02",
      to: "2026-10-06",
      events: [],
      toleranceDays: 2,
    });

    expect(missed).toEqual([]);
  });

  it("checks the river against its historical high, at WARNING", () => {
    const river = observed({ river_discharge: [600, 1300, 1100, 700] });

    expect(scan({}, [], river)).toMatchObject([
      { hazard: "river_flood", level: "WARNING", windowStart: "2026-10-02", windowEnd: "2026-10-03" },
    ]);
  });

  it("finds nothing in ordinary weather", () => {
    expect(
      scan({
        precipitation_sum: [5, 0, 12, 0, 0, 30, 0],
        temperature_2m_max: [31, 32, 33, 32, 31, 30, 30],
        temperature_2m_min: [20, 21, 20, 19, 20, 21, 20],
        wind_gusts_10m_max: [20, 25, 30, 22, 18, 20, 21],
      }),
    ).toEqual([]);
  });

  it("is not fooled by a missed event it recorded on an earlier run", () => {
    const first = scan({ precipitation_sum: [0, 0, 0, 92] });
    const again = scan({ precipitation_sum: [0, 0, 0, 92] }, first);

    expect(again).toEqual([]);
  });
});
