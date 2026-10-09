import { describe, expect, it } from "vitest";
import type { Hazard } from "../types.js";
import { baseTripwires, evaluateRules, shortDate, snapshotOf as toSnapshot } from "./rules.js";
import {
  RIVER,
  SETTINGS,
  START,
  detailedOf,
  snapshotOf,
  type DetailScript,
} from "./testing/fixtures.js";
import type { Snapshot } from "./types.js";

// Day 0 is 9 Oct 2026, the day of START
function run(script: DetailScript = {}, previous: Snapshot | null = snapshotOf()) {
  const detailed = detailedOf(script);
  return evaluateRules({
    now: START,
    profile: detailed.profile,
    forecast: detailed.forecast,
    previous,
    settings: SETTINGS,
  });
}

const finding = (result: ReturnType<typeof run>, hazard: Hazard) =>
  result.findings.find((f) => f.hazard === hazard);

describe("rain and flash flood", () => {
  it("raises a WATCH at 30% probability and 90 mm", () => {
    const result = run({ weather: { rain: [0, 0, 90], probability: [0, 0, 30] } });

    expect(result.levels.flash_flood).toBe("WATCH");
    expect(result.sudden.map((f) => f.hazard)).toEqual(["flash_flood"]);
  });

  it("does not escalate at 20% probability, however much rain", () => {
    const result = run({ weather: { rain: [0, 0, 90], probability: [0, 0, 20] } });

    expect(result.levels.flash_flood).toBe("NORMAL");
    expect(result.level).toBe("NORMAL");
    expect(result.findings).toEqual([]);
    expect(result.sudden).toEqual([]);
  });

  it("raises a WARNING at 60% probability and 130 mm", () => {
    const result = run({ weather: { rain: [0, 130], probability: [0, 60] } });

    expect(result.levels.flash_flood).toBe("WARNING");
    expect(result.level).toBe("WARNING");
  });

  it("raises SEVERE for extremely heavy rain", () => {
    expect(run({ weather: { rain: [210] } }).levels.flash_flood).toBe("SEVERE");
  });

  it("applies the IMD class boundaries exactly", () => {
    const level = (mm: number) => run({ weather: { rain: [mm] } }).levels.flash_flood;

    expect(level(64.4)).toBe("NORMAL");
    expect(level(64.5)).toBe("WATCH");
    expect(level(115.5)).toBe("WATCH");
    expect(level(115.6)).toBe("WARNING");
    expect(level(204.4)).toBe("WARNING");
    expect(level(204.5)).toBe("SEVERE");
  });

  it("counts a probability of exactly 25%", () => {
    expect(run({ weather: { rain: [90], probability: [25] } }).levels.flash_flood).toBe("WATCH");
    expect(run({ weather: { rain: [90], probability: [24.9] } }).levels.flash_flood).toBe("NORMAL");
  });

  it("ignores a wetter day that is too unlikely and reports the likely one", () => {
    const result = run({ weather: { rain: [0, 150, 0, 82], probability: [0, 10, 0, 60] } });

    expect(finding(result, "flash_flood")).toMatchObject({
      level: "WATCH",
      windowStart: "2026-10-12",
      windowEnd: "2026-10-12",
      evidence: "82 mm rain forecast on 12 Oct, 60% probability",
    });
  });

  it("spans every qualifying day and names the wettest", () => {
    const result = run({ weather: { rain: [0, 70, 130, 0, 90] } });

    expect(finding(result, "flash_flood")).toMatchObject({
      level: "WARNING",
      windowStart: "2026-10-10",
      windowEnd: "2026-10-13",
      evidence: "130 mm rain forecast on 11 Oct, 80% probability",
      tripwire: { variable: "precipitation_sum", threshold: 115.6, direction: "above" },
      values: { rain_mm: 130, rain_probability_pct: 80, date: "2026-10-11" },
    });
  });

  it("lets the amount decide when no probability is forecast", () => {
    const result = run({ weather: { rain: [0, 90], probability: null } });

    expect(finding(result, "flash_flood")).toMatchObject({
      level: "WATCH",
      evidence: "90 mm rain forecast on 10 Oct, probability not forecast",
    });
  });
});

describe("heat", () => {
  it("raises a WATCH at 40 °C", () => {
    const result = run({ weather: { tmax: [38, 40] } });

    expect(finding(result, "heat")).toMatchObject({
      level: "WATCH",
      evidence: "40 °C max temperature forecast on 10 Oct",
      tripwire: { variable: "temperature_2m_max", threshold: 40 },
    });
  });

  it("raises a WARNING at 45 °C", () => {
    const result = run({ weather: { tmax: [41, 45, 43] } });

    expect(result.levels.heat).toBe("WARNING");
    expect(finding(result, "heat")).toMatchObject({
      windowStart: "2026-10-09",
      windowEnd: "2026-10-11",
      tripwire: { threshold: 45 },
    });
  });

  it("stays NORMAL just below 40 °C", () => {
    expect(run({ weather: { tmax: [39.9] } }).levels.heat).toBe("NORMAL");
  });
});

describe("storm", () => {
  it("uses the climate unit's gust limits: WATCH at 60 km/h, WARNING at 90", () => {
    expect(run({ weather: { gust: [59] } }).levels.storm).toBe("NORMAL");
    expect(run({ weather: { gust: [60] } }).levels.storm).toBe("WATCH");
    expect(run({ weather: { gust: [0, 95] } }).levels.storm).toBe("WARNING");
  });

  it("says so in words", () => {
    expect(finding(run({ weather: { gust: [0, 95] } }), "storm")?.evidence).toBe(
      "95 km/h wind gusts forecast on 10 Oct",
    );
  });

  it("is NORMAL when gusts are not fetched", () => {
    expect(run({ weather: { gust: null }, dormant: ["storm"] }).levels.storm).toBe("NORMAL");
  });
});

describe("river flood", () => {
  it("raises a WARNING when discharge is forecast above the cell's historical high", () => {
    const result = run({ flood: [600, 1250, 900] });

    expect(finding(result, "river_flood")).toMatchObject({
      level: "WARNING",
      evidence: "River discharge 1250 m³/s forecast on 10 Oct, above the historical high of 1000 m³/s",
      tripwire: { variable: "river_discharge", threshold: RIVER.dischargeP99 },
    });
  });

  it("raises SEVERE when heavy rain is also forecast within 72 h", () => {
    const result = run({ flood: [600, 1250], weather: { rain: [0, 0, 90] } });

    expect(finding(result, "river_flood")).toMatchObject({
      level: "SEVERE",
      evidence:
        "River discharge 1250 m³/s forecast on 10 Oct, above the historical high of 1000 m³/s; " +
        "90 mm rain forecast within 72 h",
    });
    expect(result.level).toBe("SEVERE");
  });

  it("stays at WARNING when the heavy rain is more than 72 h away", () => {
    const result = run({ flood: [600, 1250], weather: { rain: [0, 0, 0, 90] } });

    expect(result.levels.river_flood).toBe("WARNING");
  });

  it("does not count rain that is too unlikely towards SEVERE", () => {
    const result = run({ flood: [1250], weather: { rain: [90], probability: [10] } });

    expect(result.levels.river_flood).toBe("WARNING");
  });

  it("is NORMAL at or below the historical high", () => {
    expect(run({ flood: [1000, 990] }).levels.river_flood).toBe("NORMAL");
  });

  it("takes the watch level from the climate unit's own event", () => {
    const result = run({
      flood: [600, 850],
      events: [
        {
          hazard: "river_flood",
          severity: "watch",
          window_start: "2026-10-10",
          window_end: "2026-10-10",
          confidence: 0.5,
        },
      ],
    });

    expect(finding(result, "river_flood")).toMatchObject({
      level: "WATCH",
      source: "climate_event",
      evidence: "River discharge 850 m³/s forecast on 10 Oct, above the cell's 95th percentile (800 m³/s)",
      tripwire: { threshold: RIVER.dischargeP95 },
    });
  });

  it("takes SEVERE from the climate unit's ensemble-backed event", () => {
    const result = run({
      flood: [1250],
      events: [
        {
          hazard: "river_flood",
          severity: "severe",
          window_start: "2026-10-09",
          window_end: "2026-10-09",
          confidence: 0.9,
        },
      ],
    });

    expect(result.levels.river_flood).toBe("SEVERE");
  });

  it("keeps the last level when the river forecast is missing", () => {
    const result = run({ flood: null }, snapshotOf({ river_flood: "WARNING" }));

    expect(result.levels.river_flood).toBe("WARNING");
    expect(result.sudden).toEqual([]);
  });

  it("is NORMAL, not unknown, when the river is dormant and so not forecast", () => {
    const result = run({ flood: null, dormant: ["river_flood"] }, snapshotOf({ river_flood: "WATCH" }));

    expect(result.levels.river_flood).toBe("NORMAL");
  });
});

describe("cold wave", () => {
  it("comes from the climate unit's event", () => {
    const result = run({
      weather: { tmin: [6, 2, 3] },
      events: [
        {
          hazard: "cold_wave",
          severity: "watch",
          window_start: "2026-10-10",
          window_end: "2026-10-11",
          confidence: 0.6,
        },
      ],
    });

    expect(finding(result, "cold_wave")).toMatchObject({
      level: "WATCH",
      windowStart: "2026-10-10",
      windowEnd: "2026-10-11",
      evidence: "2 °C min temperature forecast on 10 Oct",
      tripwire: { variable: "temperature_2m_min", threshold: 4, direction: "below" },
    });
  });
});

describe("sudden change", () => {
  it("is a hazard level above the one in the last snapshot", () => {
    const result = run({ weather: { tmax: [46] } }, snapshotOf({ heat: "WATCH" }));

    expect(result.sudden.map((f) => [f.hazard, f.level])).toEqual([["heat", "WARNING"]]);
  });

  it("is not a hazard that stays where it was", () => {
    const result = run({ weather: { tmax: [46] } }, snapshotOf({ heat: "WARNING" }));

    expect(result.levels.heat).toBe("WARNING");
    expect(result.sudden).toEqual([]);
  });

  it("is not a hazard that eased", () => {
    const result = run({ weather: { tmax: [41] } }, snapshotOf({ heat: "WARNING" }));

    expect(result.levels.heat).toBe("WATCH");
    expect(result.sudden).toEqual([]);
  });

  it("treats every hazard as NORMAL before a cell's first check", () => {
    const result = run({ weather: { tmax: [41], rain: [0, 90] } }, null);

    expect(result.sudden.map((f) => f.hazard).sort()).toEqual(["flash_flood", "heat"]);
  });

  it("is a dormant hazard whose tripwire trips", () => {
    // Heavy rain where flash floods are dormant: only the tripwire variables
    // are fetched, so there is no probability
    const result = run({ dormant: ["flash_flood"], weather: { rain: [0, 70], probability: null } });

    expect(result.sudden).toHaveLength(1);
    expect(result.sudden[0]).toMatchObject({
      hazard: "flash_flood",
      dormant: true,
      // 70 mm is a WATCH by amount; a reactivated hazard is at least a WARNING
      level: "WARNING",
      evidence:
        "70 mm rain forecast on 10 Oct, probability not forecast; this hazard is normally dormant here",
      tripwire: { variable: "precipitation_sum", threshold: 64.5 },
    });
  });

  it("still sees a dormant hazard the climate unit already promoted for this response", () => {
    const result = run({ promoted: ["heat"], weather: { tmax: [41] } });

    expect(result.sudden[0]).toMatchObject({ hazard: "heat", dormant: true, level: "WARNING" });
  });

  it("does not repeat a dormant hazard that tripped on the last check too", () => {
    const result = run(
      { dormant: ["heat"], weather: { tmax: [41] } },
      snapshotOf({ heat: "WARNING" }),
    );

    expect(result.levels.heat).toBe("WARNING");
    expect(result.sudden).toEqual([]);
  });

  it("reports several hazards rising at once", () => {
    const result = run({ weather: { rain: [130], tmax: [0, 46], gust: [0, 0, 70] } });

    expect(result.sudden.map((f) => [f.hazard, f.level])).toEqual([
      ["flash_flood", "WARNING"],
      ["heat", "WARNING"],
      ["storm", "WATCH"],
    ]);
    expect(result.level).toBe("WARNING");
  });
});

describe("result", () => {
  it("is all NORMAL for a calm forecast", () => {
    const result = run({ flood: [500, 520] });

    expect(new Set(Object.values(result.levels))).toEqual(new Set(["NORMAL"]));
    expect(result.findings).toEqual([]);
  });

  it("never raises drought, which is slow-onset", () => {
    expect(run({ weather: { rain: [0], tmax: [46] } }).levels.drought).toBe("NORMAL");
  });

  it("records the key forecast values and the unit's forecast scores for the snapshot", () => {
    const result = run({
      weather: { rain: [0, 82], probability: [0, 60], tmax: [30, 41], gust: [20, 45] },
      flood: [600, 900],
      forecastScores: { heat: 0.55 },
    });

    expect(result.values).toMatchObject({
      rainMaxMm: 82,
      rainProbabilityPct: 60,
      tmaxC: 41,
      gustKmh: 45,
      dischargeMaxM3s: 900,
      riverHighM3s: 1000,
    });
    expect(result.values.forecastScores.heat).toBe(0.55);
  });

  it("turns into a snapshot the next check can compare against", () => {
    const result = run({ weather: { tmax: [46] } });
    const snapshot = toSnapshot(result, START);

    expect(snapshot).toMatchObject({ at: START.toISOString(), levels: { heat: "WARNING" } });
    expect(run({ weather: { tmax: [46] } }, snapshot).sudden).toEqual([]);
  });

  it("is pure: the same input gives the same output and nothing is changed", () => {
    const detailed = detailedOf({ weather: { rain: [0, 130], tmax: [46] }, flood: [1250] });
    const input = {
      now: START,
      profile: detailed.profile,
      forecast: detailed.forecast,
      previous: snapshotOf(),
      settings: SETTINGS,
    };
    const before = JSON.stringify(input);

    const first = evaluateRules(input);
    const second = evaluateRules(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("reads its rain classes from the settings", () => {
    const detailed = detailedOf({ weather: { rain: [50] } });
    const result = evaluateRules({
      now: START,
      profile: detailed.profile,
      forecast: detailed.forecast,
      previous: null,
      settings: { ...SETTINGS, rain: { ...SETTINGS.rain, heavyMm: 40 } },
    });

    expect(result.levels.flash_flood).toBe("WATCH");
  });
});

describe("helpers", () => {
  it("formats a date the way people read it", () => {
    expect(shortDate("2026-10-12")).toBe("12 Oct");
    expect(shortDate("2026-01-03")).toBe("3 Jan");
  });

  it("lists the lowest tripwire of each hazard, with no river one when the river is unknown", () => {
    expect(Object.keys(baseTripwires(null, SETTINGS)).sort()).toEqual([
      "cold_wave",
      "flash_flood",
      "heat",
      "storm",
    ]);
    expect(baseTripwires(RIVER, SETTINGS).river_flood).toEqual({
      tripwire: { variable: "river_discharge", threshold: 1000, direction: "above" },
      level: "WARNING",
    });
  });
});
