import { describe, expect, it } from "vitest";
import {
  computeProjectionDeltas,
  computeRiverIndicators,
  computeWeatherIndicators,
  dailyMeans,
  percentile,
  rollingSum,
} from "./stats.js";
import type { TimeSeries } from "./types.js";

function days(start: string, count: number): string[] {
  const first = Date.parse(start);
  return Array.from({ length: count }, (_, i) =>
    new Date(first + i * 86_400_000).toISOString().slice(0, 10),
  );
}

describe("percentile", () => {
  it("interpolates between ranks", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20], 50)).toBe(15);
    expect(percentile([5, 1, 3], 100)).toBe(5);
  });

  it("ignores missing values and returns 0 when there is no data", () => {
    expect(percentile([null, 4, null, 8], 50)).toBe(6);
    expect(percentile([null, null], 99)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });
});

describe("rollingSum", () => {
  it("sums each window and leaves gaps where a day is missing", () => {
    expect(rollingSum([1, 2, 3, 4], 3)).toEqual([6, 9]);
    expect(rollingSum([1, null, 3, 4, 5], 3)).toEqual([null, null, 12]);
    expect(rollingSum([1, 2], 3)).toEqual([]);
  });
});

describe("computeWeatherIndicators", () => {
  it("counts threshold days per year", () => {
    const time = days("2001-01-01", 730);
    const history: TimeSeries = {
      time,
      values: {
        // 10 hot days in each year
        temperature_2m_max: time.map((_, i) => (i % 365 < 10 ? 42 : 30)),
        temperature_2m_min: time.map((_, i) => (i % 365 < 4 ? 2 : 15)),
        wind_gusts_10m_max: time.map(() => 20),
        precipitation_sum: time.map((_, i) => (i % 365 < 2 ? 60 : 0)),
      },
    };

    const result = computeWeatherIndicators(history);

    expect(result.years).toBeCloseTo(2, 1);
    expect(result.heatDaysPerYear).toBeCloseTo(10, 0);
    expect(result.coldDaysPerYear).toBeCloseTo(4, 0);
    expect(result.heavyRainDaysPerYear).toBeCloseTo(2, 0);
    expect(result.stormDaysPerYear).toBe(0);
    expect(result.historyUntil).toBe(time.at(-1));
    expect(result.tmaxP99).toBe(42);
  });

  it("measures the share of weak-monsoon years", () => {
    const time = days("2001-01-01", 365 * 4 + 1);
    // 2003 gets a third of the usual Jun-Sep rain
    const precipitation = time.map((date) => {
      const month = date.slice(5, 7);
      if (month < "06" || month > "09") return 0;
      return date.startsWith("2003") ? 2 : 6;
    });

    const result = computeWeatherIndicators({
      time,
      values: { temperature_2m_max: time.map(() => 30), precipitation_sum: precipitation },
    });

    expect(result.droughtYearShare).toBe(0.25);
  });

  it("does not crash on an empty history", () => {
    const result = computeWeatherIndicators({ time: [], values: {} });
    expect(result).toMatchObject({ years: 0, heatDaysPerYear: 0, historyUntil: null });
  });
});

describe("computeRiverIndicators", () => {
  it("derives local discharge thresholds", () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    const result = computeRiverIndicators({
      time: days("2001-01-01", 101),
      values: { river_discharge: values },
    });
    expect(result).toEqual({ dischargeMedian: 50, dischargeP95: 95, dischargeP99: 99 });
  });

  it("returns null when the cell has no modelled river", () => {
    const time = days("2001-01-01", 3);
    expect(
      computeRiverIndicators({ time, values: { river_discharge: [null, null, null] } }),
    ).toBeNull();
  });
});

describe("computeProjectionDeltas", () => {
  it("compares the future window against the baseline, per model", () => {
    const time = [...days("2000-01-01", 366), ...days("2030-01-01", 365)];
    const future = (date: string) => date.startsWith("2030");
    const values: TimeSeries["values"] = {};
    for (const model of ["EC_Earth3P_HR", "MRI_AGCM3_2_S"]) {
      // 10 more hot days and 20% less rain in the future window
      values[`temperature_2m_max_${model}`] = time.map((d) =>
        future(d) && d.slice(5, 10) <= "01-10" ? 42 : 30,
      );
      values[`precipitation_sum_${model}`] = time.map((d) => (future(d) ? 4 : 5));
      values[`soil_moisture_0_to_10cm_mean_${model}`] = time.map(() => 0.3);
    }

    const result = computeProjectionDeltas({ time, values });

    expect(result.heatDaysDelta).toBeCloseTo(10, 0);
    expect(result.precipChangePct).toBeCloseTo(-20, 5);
    expect(result.soilMoistureChangePct).toBeCloseTo(0, 5);
  });

  it("returns nulls when no model data is present", () => {
    expect(computeProjectionDeltas({ time: [], values: {} })).toEqual({
      heatDaysDelta: null,
      precipChangePct: null,
      soilMoistureChangePct: null,
      heavyRainChangePct: null,
    });
  });
});

describe("dailyMeans", () => {
  it("averages hourly values per day", () => {
    const result = dailyMeans(
      ["2026-10-09T00:00", "2026-10-09T12:00", "2026-10-10T00:00", "2026-10-11T00:00"],
      [0.2, 0.4, 0.3, null],
    );
    expect(result.time).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(result.values[0]).toBeCloseTo(0.3);
    expect(result.values.slice(1)).toEqual([0.3, null]);
  });
});
