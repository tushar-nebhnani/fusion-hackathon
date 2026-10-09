import { CLIMATE } from "../../config/climate.js";
import { LIMITS } from "./hazards.js";
import type {
  ProjectionDeltas,
  RiverIndicators,
  Series,
  TimeSeries,
  WeatherIndicators,
} from "./types.js";

const DAYS_PER_YEAR = 365.25;

function present(values: Series): number[] {
  return values.filter((v): v is number => v !== null);
}

// Linear-interpolated percentile over the non-null values; 0 when empty
export function percentile(values: Series, p: number): number {
  const sorted = present(values).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lowValue = sorted[low] ?? 0;
  const highValue = sorted[high] ?? lowValue;
  return lowValue + (highValue - lowValue) * (rank - low);
}

export function mean(values: Series): number | null {
  const numbers = present(values);
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, v) => sum + v, 0) / numbers.length;
}

// Sum of each `window`-day run; null where any day in the run is missing
export function rollingSum(values: Series, window: number): Series {
  const sums: Series = [];
  for (let i = 0; i + window <= values.length; i++) {
    let sum: number | null = 0;
    for (let j = i; j < i + window; j++) {
      const value = values[j] ?? null;
      if (value === null) {
        sum = null;
        break;
      }
      sum += value;
    }
    sums.push(sum);
  }
  return sums;
}

function daysPerYear(values: Series, test: (value: number) => boolean): number {
  const numbers = present(values);
  if (numbers.length === 0) return 0;
  return numbers.filter(test).length / (numbers.length / DAYS_PER_YEAR);
}

function series(data: TimeSeries, variable: string): Series {
  return data.values[variable] ?? [];
}

// Share of years whose Jun-Sep rain fell below 75% of the long-run normal
function droughtYearShare(time: string[], precipitation: Series): number {
  const totals = new Map<string, { sum: number; days: number }>();
  time.forEach((date, i) => {
    const month = date.slice(5, 7);
    const value = precipitation[i] ?? null;
    if (value === null || month < "06" || month > "09") return;
    const year = date.slice(0, 4);
    const entry = totals.get(year) ?? { sum: 0, days: 0 };
    entry.sum += value;
    entry.days += 1;
    totals.set(year, entry);
  });

  // Only near-complete monsoon seasons (122 days) count
  const seasons = [...totals.values()].filter((t) => t.days >= 110).map((t) => t.sum);
  const normal = mean(seasons);
  if (normal === null || normal === 0) return 0;
  const deficit = seasons.filter((sum) => sum < LIMITS.droughtMonsoonShare * normal);
  return deficit.length / seasons.length;
}

export function computeWeatherIndicators(history: TimeSeries): WeatherIndicators {
  const tmax = series(history, "temperature_2m_max");
  const precipitation = series(history, "precipitation_sum");
  const rain3d = rollingSum(precipitation, 3);

  let historyUntil: string | null = null;
  history.time.forEach((date, i) => {
    if ((tmax[i] ?? null) !== null) historyUntil = date;
  });

  return {
    years: present(tmax).length / DAYS_PER_YEAR,
    historyUntil,
    heatDaysPerYear: daysPerYear(tmax, (v) => v > LIMITS.heatC),
    coldDaysPerYear: daysPerYear(series(history, "temperature_2m_min"), (v) => v < LIMITS.coldC),
    stormDaysPerYear: daysPerYear(series(history, "wind_gusts_10m_max"), (v) => v > LIMITS.gustKmh),
    heavyRainDaysPerYear: daysPerYear(precipitation, (v) => v >= LIMITS.heavyRainMm),
    droughtYearShare: droughtYearShare(history.time, precipitation),
    rain3dP95: percentile(rain3d, 95),
    rain3dP99: percentile(rain3d, 99),
    tmaxP95: percentile(tmax, 95),
    tmaxP99: percentile(tmax, 99),
  };
}

export function computeRiverIndicators(history: TimeSeries): RiverIndicators | null {
  const discharge = series(history, "river_discharge");
  if (present(discharge).length === 0) return null;
  return {
    dischargeMedian: percentile(discharge, 50),
    dischargeP95: percentile(discharge, 95),
    dischargeP99: percentile(discharge, 99),
  };
}

function slice(data: TimeSeries, variable: string, start: string, end: string): Series {
  const values = series(data, variable);
  return data.time.flatMap((date, i) =>
    date >= start && date <= end ? [values[i] ?? null] : [],
  );
}

function average(values: (number | null)[]): number | null {
  return mean(values);
}

function percentChange(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
}

// Change between the baseline and near-future windows, averaged over models.
// Open-Meteo suffixes each variable with the model name.
export function computeProjectionDeltas(projections: TimeSeries): ProjectionDeltas {
  const { projectionBaseline: base, projectionFuture: future } = CLIMATE;
  const heat: (number | null)[] = [];
  const rain: (number | null)[] = [];
  const soil: (number | null)[] = [];
  const heavyRain: (number | null)[] = [];

  for (const model of CLIMATE.climateModels) {
    const window = (variable: string, w: { start: string; end: string }) =>
      slice(projections, `${variable}_${model}`, w.start, w.end);

    const tmaxBase = window("temperature_2m_max", base);
    const tmaxFuture = window("temperature_2m_max", future);
    if (present(tmaxBase).length > 0 && present(tmaxFuture).length > 0) {
      const hot = (v: number) => v > LIMITS.heatC;
      heat.push(daysPerYear(tmaxFuture, hot) - daysPerYear(tmaxBase, hot));
    }

    const rainBase = window("precipitation_sum", base);
    const rainFuture = window("precipitation_sum", future);
    rain.push(percentChange(mean(rainBase), mean(rainFuture)));
    if (present(rainBase).length > 0 && present(rainFuture).length > 0) {
      heavyRain.push(percentChange(percentile(rainBase, 99), percentile(rainFuture, 99)));
    }

    soil.push(
      percentChange(
        mean(window("soil_moisture_0_to_10cm_mean", base)),
        mean(window("soil_moisture_0_to_10cm_mean", future)),
      ),
    );
  }

  return {
    heatDaysDelta: average(heat),
    precipChangePct: average(rain),
    soilMoistureChangePct: average(soil),
    heavyRainChangePct: average(heavyRain),
  };
}

// Hourly values averaged per calendar day (timestamps are "YYYY-MM-DDTHH:MM")
export function dailyMeans(time: string[], values: Series): { time: string[]; values: Series } {
  const byDay = new Map<string, number[]>();
  time.forEach((timestamp, i) => {
    const day = timestamp.slice(0, 10);
    const bucket = byDay.get(day) ?? [];
    const value = values[i] ?? null;
    if (value !== null) bucket.push(value);
    byDay.set(day, bucket);
  });
  const days = [...byDay.keys()];
  return { time: days, values: days.map((day) => mean(byDay.get(day) ?? [])) };
}
