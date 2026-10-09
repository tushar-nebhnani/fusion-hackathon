import { describe, expect, it } from "vitest";
import {
  confidenceLevel,
  detectEvents,
  forecastScore,
  grade,
  hazardScore,
  historicalScore,
  overallRisk,
  projectionAdjustment,
  structuralScore,
} from "./scoring.js";
import { classify, screenRiver, screenWeather } from "./screening.js";
import { HAZARDS, type Hazard, type HazardProfile, type WeatherIndicators } from "./types.js";

const weather: WeatherIndicators = {
  years: 30,
  historyUntil: "2026-10-03",
  heatDaysPerYear: 30,
  coldDaysPerYear: 0,
  stormDaysPerYear: 1,
  heavyRainDaysPerYear: 4,
  droughtYearShare: 0,
  rain3dP95: 60,
  rain3dP99: 120,
  tmaxP95: 41,
  tmaxP99: 43,
};
const river = { dischargeMedian: 500, dischargeP95: 2000, dischargeP99: 5000 };

function profile(hazard: Hazard, overrides: Partial<HazardProfile> = {}): HazardProfile {
  return {
    hazard,
    relevance: "primary",
    method: "static",
    indicatorValue: 10,
    reason: "",
    indicators: { weather, river, primaryThreshold: 10, projectionAdjustment: 0 },
    ...overrides,
  };
}

const profiles = () =>
  Object.fromEntries(HAZARDS.map((h) => [h, profile(h)])) as Record<Hazard, HazardProfile>;

const time = ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];

describe("screening", () => {
  it("classifies against the primary and dormant thresholds", () => {
    expect(classify(20, 20, 2)).toBe("primary");
    expect(classify(19.9, 20, 2)).toBe("secondary");
    expect(classify(2, 20, 2)).toBe("secondary");
    expect(classify(1.9, 20, 2)).toBe("dormant");
  });

  it("screens the weather hazards from history", () => {
    const screened = screenWeather(weather);

    expect(screened.heat.relevance).toBe("primary");
    expect(screened.flash_flood.relevance).toBe("primary");
    expect(screened.storm.relevance).toBe("secondary");
    expect(screened.cold_wave.relevance).toBe("dormant");
    expect(screened.drought.relevance).toBe("dormant");
    expect(screened.heat.reason).toContain("30.0 days per year");
  });

  it("screens river flood from discharge when exposure is unknown", () => {
    expect(screenRiver(river, null).relevance).toBe("primary");
    expect(screenRiver({ ...river, dischargeP99: 300 }, null).relevance).toBe("secondary");
    expect(screenRiver({ ...river, dischargeP99: 5 }, null).relevance).toBe("dormant");
    expect(screenRiver(null, null).relevance).toBe("dormant");
  });

  it("prefers the exposure share when it is available", () => {
    expect(screenRiver({ ...river, dischargeP99: 5 }, 0.25)).toMatchObject({
      relevance: "primary",
      indicatorValue: 0.25,
      primaryThreshold: 0.2,
    });
    expect(screenRiver({ ...river, dischargeP99: 5 }, 0.01).relevance).toBe("dormant");
    expect(screenRiver(river, 0.01).relevance).toBe("secondary");
  });

  it("never marks river flood dormant when its source failed", () => {
    expect(screenRiver(null, null, true)).toMatchObject({
      relevance: "secondary",
      indicatorValue: null,
    });
    expect(screenRiver(null, 0.01, true).relevance).toBe("secondary");
  });
});

describe("scores", () => {
  it("scores history at 0.5 on the primary threshold and saturates at twice it", () => {
    expect(historicalScore(profile("heat", { indicatorValue: 0 }))).toBe(0);
    expect(historicalScore(profile("heat", { indicatorValue: 10 }))).toBe(0.5);
    expect(historicalScore(profile("heat", { indicatorValue: 50 }))).toBe(1);
    expect(historicalScore(profile("heat", { indicatorValue: null }))).toBe(0.25);
  });

  it("gives only flood hazards a structural score", () => {
    const low = { elevationM: 40, relativeElevationM: -10, floodExposureShare: null };
    const high = { ...low, relativeElevationM: 10 };

    expect(structuralScore("flash_flood", low)).toBe(1);
    expect(structuralScore("flash_flood", high)).toBe(0);
    expect(structuralScore("river_flood", { ...high, floodExposureShare: 0.4 })).toBeCloseTo(0.7);
    expect(structuralScore("heat", low)).toBeNull();
    expect(
      structuralScore("river_flood", { ...low, relativeElevationM: null }),
    ).toBeNull();
  });

  it("applies the 0.3 / 0.5 / 0.2 weights", () => {
    expect(hazardScore({ structural: 1, historical: 0, forecast: 0 }, 0)).toBeCloseTo(0.3);
    expect(hazardScore({ structural: 0, historical: 1, forecast: 0 }, 0)).toBeCloseTo(0.5);
    expect(hazardScore({ structural: 0, historical: 0, forecast: 1 }, 0)).toBeCloseTo(0.2);
  });

  it("moves the structural weight to historical when there is no structural signal", () => {
    expect(hazardScore({ structural: null, historical: 1, forecast: 0 }, 0)).toBeCloseTo(0.8);
  });

  it("adds the projection adjustment and never exceeds 1", () => {
    expect(hazardScore({ structural: null, historical: 0.5, forecast: 0 }, 0.1)).toBeCloseTo(0.5);
    expect(hazardScore({ structural: 1, historical: 1, forecast: 1 }, 0.1)).toBe(1);
  });

  it("caps the projection adjustment at 0.1 and only applies it to worsening hazards", () => {
    const deltas = {
      heatDaysDelta: 40,
      precipChangePct: -10,
      soilMoistureChangePct: 5,
      heavyRainChangePct: -30,
    };
    expect(projectionAdjustment("heat", deltas)).toBeCloseTo(0.1);
    expect(projectionAdjustment("drought", deltas)).toBeCloseTo(0.05);
    expect(projectionAdjustment("flash_flood", deltas)).toBe(0);
    expect(projectionAdjustment("storm", deltas)).toBe(0);
    expect(projectionAdjustment("heat", null)).toBe(0);
  });

  it("weights the overall risk by relevance, with dormant never zero", () => {
    expect(
      overallRisk([
        { relevance: "primary", score: 1 },
        { relevance: "secondary", score: 0 },
        { relevance: "dormant", score: 0 },
      ]),
    ).toBeCloseTo(1 / 1.6);
    expect(overallRisk([{ relevance: "dormant", score: 0.8 }])).toBeCloseTo(0.8);
    expect(overallRisk([])).toBe(0);
  });

  it.each([
    [0, "A"],
    [0.199, "A"],
    [0.2, "B"],
    [0.349, "B"],
    [0.35, "C"],
    [0.5, "D"],
    [0.699, "D"],
    [0.7, "E"],
    [1, "E"],
  ])("grades %d as %s", (risk, expected) => {
    expect(grade(risk)).toBe(expected);
  });

  it("derives confidence from data quality", () => {
    const good = { primaryMissing: false, secondaryMissing: false };
    expect(confidenceLevel(good)).toBe("high");
    expect(confidenceLevel({ ...good, secondaryMissing: true })).toBe("med");
    expect(confidenceLevel({ ...good, secondaryMissing: true, primaryMissing: true })).toBe("low");
    expect(confidenceLevel({ ...good, primaryMissing: true })).toBe("low");
  });

  it("scores the forecast against local thresholds", () => {
    const calm = { time, values: { precipitation_sum: [0, 0, 0, 0, 0], temperature_2m_max: [30, 31, 30, 30, 30] } };
    const wet = { time, values: { precipitation_sum: [0, 40, 40, 40, 0], temperature_2m_max: [45, 31, 30, 30, 30] } };

    expect(forecastScore(profile("flash_flood"), { weather: calm, flood: null })).toBe(0);
    expect(forecastScore(profile("flash_flood"), { weather: wet, flood: null })).toBe(1);
    expect(forecastScore(profile("heat"), { weather: calm, flood: null })).toBe(0);
    expect(forecastScore(profile("heat"), { weather: wet, flood: null })).toBe(1);
    expect(forecastScore(profile("storm"), { weather: calm, flood: null })).toBe(0);
    expect(forecastScore(profile("heat"), { weather: null, flood: null })).toBe(0);
  });
});

describe("detectEvents", () => {
  const rain = (values: number[]) => ({
    weather: { time, values: { precipitation_sum: values, temperature_2m_max: [30, 30, 30, 30, 30] } },
    flood: null,
  });

  it("raises nothing in calm weather", () => {
    expect(detectEvents(profiles(), rain([0, 5, 5, 0, 0]))).toEqual([]);
  });

  it("raises a flash flood watch above the local 95th percentile", () => {
    expect(detectEvents(profiles(), rain([0, 30, 30, 20, 0]))).toEqual([
      expect.objectContaining({
        hazard: "flash_flood",
        severity: "watch",
        windowStart: "2026-10-10",
        windowEnd: "2026-10-12",
      }),
    ]);
  });

  it("raises a flash flood warning above the local 99th percentile", () => {
    const [event] = detectEvents(profiles(), rain([0, 50, 50, 50, 0]));
    expect(event).toMatchObject({ hazard: "flash_flood", severity: "warning" });
  });

  it("ignores rain below the absolute floor even in a dry cell", () => {
    const dry = profiles();
    dry.flash_flood = profile("flash_flood", {
      indicators: {
        weather: { ...weather, rain3dP95: 5, rain3dP99: 10 },
        primaryThreshold: 3,
        projectionAdjustment: 0,
      },
    });
    expect(detectEvents(dry, rain([0, 8, 8, 8, 0]))).toEqual([]);
    expect(detectEvents(dry, rain([0, 15, 15, 15, 0]))).toHaveLength(1);
  });

  it("raises heat events only above both 40°C and the local norm", () => {
    const heat = (tmax: number[]) => ({
      weather: { time, values: { precipitation_sum: [0, 0, 0, 0, 0], temperature_2m_max: tmax } },
      flood: null,
    });
    expect(detectEvents(profiles(), heat([40.5, 40, 39, 38, 37]))).toEqual([]);
    expect(detectEvents(profiles(), heat([38, 42, 42.5, 38, 37]))).toEqual([
      expect.objectContaining({
        hazard: "heat",
        severity: "watch",
        windowStart: "2026-10-10",
        windowEnd: "2026-10-11",
      }),
    ]);
    expect(detectEvents(profiles(), heat([38, 42, 44, 38, 37]))[0]?.severity).toBe("warning");
  });

  it("grades river flood events by how much of the ensemble agrees", () => {
    const flood = (discharge: number[], median: number[]) => ({
      weather: null,
      flood: {
        time,
        values: {
          river_discharge: discharge,
          river_discharge_median: median,
          river_discharge_p75: median,
        },
      },
    });
    const calm = [500, 500, 500, 500, 500];

    expect(detectEvents(profiles(), flood(calm, calm))).toEqual([]);
    expect(detectEvents(profiles(), flood([500, 2500, 500, 500, 500], calm))[0]).toMatchObject({
      hazard: "river_flood",
      severity: "watch",
    });
    expect(detectEvents(profiles(), flood([500, 6000, 500, 500, 500], calm))[0]).toMatchObject({
      severity: "warning",
      confidence: 0.6,
    });
    expect(
      detectEvents(profiles(), flood([500, 6000, 6000, 500, 500], [500, 5500, 500, 500, 500]))[0],
    ).toMatchObject({ severity: "severe", windowStart: "2026-10-10", windowEnd: "2026-10-11" });
  });
});
