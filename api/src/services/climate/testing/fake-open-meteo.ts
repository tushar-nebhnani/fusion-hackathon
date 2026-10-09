import {
  parsePayload,
  UpstreamError,
  type OpenMeteoClient,
  type UpstreamResult,
} from "../open-meteo.js";
import { addDays, istDate } from "../profile.service.js";
import { CLIMATE } from "../../../config/climate.js";
import { CLIMATE_VARIABLES } from "../hazards.js";

type Api = "elevation" | "archive" | "flood_history" | "climate" | "forecast" | "flood_forecast";

// Synthetic climate for one cell. Every year of history is identical.
export interface FakeClimate {
  hotDaysPerYear: number;
  coldDaysPerYear: number;
  gustyDaysPerYear: number;
  heavyRainDaysPerYear: number;
  // Typical river discharge in m3/s; null means no river is modelled
  riverDischarge: number | null;
  // Values for today onwards; days not given fall back to calm weather
  forecastRain: number[];
  forecastTmax: number[];
  forecastDischarge: number[];
  failing: Api[];
}

export interface FakeOpenMeteo extends OpenMeteoClient {
  calls: Api[];
  climateOf: FakeClimate;
}

const DAY_MS = 86_400_000;

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function dayOfYear(date: string): number {
  return Math.round((Date.parse(date) - Date.parse(`${date.slice(0, 4)}-01-01`)) / DAY_MS);
}

const between = (value: number, start: number, length: number) =>
  value >= start && value < start + length;

export function fakeOpenMeteo(
  now: () => Date,
  overrides: Partial<FakeClimate> = {},
): FakeOpenMeteo {
  const climateOf: FakeClimate = {
    hotDaysPerYear: 30,
    coldDaysPerYear: 0,
    gustyDaysPerYear: 0,
    heavyRainDaysPerYear: 4,
    riverDischarge: 500,
    forecastRain: [],
    forecastTmax: [],
    forecastDischarge: [],
    failing: [],
    ...overrides,
  };
  const calls: Api[] = [];

  function respond(api: Api, json: unknown): Promise<UpstreamResult> {
    calls.push(api);
    if (climateOf.failing.includes(api)) {
      return Promise.reject(new UpstreamError(api, "simulated outage"));
    }
    return Promise.resolve(parsePayload(api, json));
  }

  const daily = (time: string[], variables: Record<string, (date: string, i: number) => number | null>) => ({
    latitude: 26.1,
    longitude: 91.7,
    // Real weather responses carry the cell elevation as a single number
    elevation: 101,
    daily: {
      time,
      ...Object.fromEntries(
        Object.entries(variables).map(([name, value]) => [name, time.map(value)]),
      ),
    },
  });

  return {
    calls,
    climateOf,

    async elevation(points) {
      const result = await respond("elevation", {
        elevation: points.map((_, i) => (i === 0 ? 50 : 55)),
      });
      const elevation = result.payload.elevation;
      return Array.isArray(elevation) ? elevation : [];
    },

    archive(_point, startDate, endDate) {
      const c = climateOf;
      const rain = (date: string) => {
        const day = dayOfYear(date);
        if (between(day, 170, c.heavyRainDaysPerYear)) return 80;
        return between(day, 152, 122) ? 5 : 0;
      };
      return respond(
        "archive",
        daily(dateRange(startDate, endDate), {
          temperature_2m_max: (date) => (dayOfYear(date) < c.hotDaysPerYear ? 42 : 30),
          temperature_2m_min: (date) => (dayOfYear(date) >= 365 - c.coldDaysPerYear ? 2 : 15),
          apparent_temperature_max: () => 32,
          precipitation_sum: rain,
          precipitation_hours: (date) => (rain(date) > 0 ? 4 : 0),
          et0_fao_evapotranspiration: () => 4,
          wind_gusts_10m_max: (date) =>
            between(dayOfYear(date), 100, c.gustyDaysPerYear) ? 70 : 20,
          wind_speed_10m_max: () => 10,
        }),
      );
    },

    floodHistory(_point, startDate, endDate) {
      const base = climateOf.riverDischarge;
      return respond(
        "flood_history",
        daily(dateRange(startDate, endDate), {
          river_discharge: (date) =>
            base === null ? null : between(dayOfYear(date), 200, 4) ? base * 10 : base,
        }),
      );
    },

    climate(_point, startDate, endDate) {
      const values = { temperature_2m_max: 30, precipitation_sum: 3, soil_moisture_0_to_10cm_mean: 0.3 };
      const variables: Record<string, () => number> = {};
      for (const model of CLIMATE.climateModels) {
        for (const name of CLIMATE_VARIABLES) {
          variables[`${name}_${model}`] = () => values[name as keyof typeof values];
        }
      }
      return respond("climate", daily(dateRange(startDate, endDate), variables));
    },

    forecast(_point, dailyVariables, hourlyVariables) {
      const today = istDate(now());
      const time = dateRange(addDays(today, -CLIMATE.forecastPastDays), addDays(today, 6));
      const fromToday = (list: number[], fallback: number) => (_date: string, i: number) =>
        list[i - CLIMATE.forecastPastDays] ?? fallback;
      const calm: Record<string, (date: string, i: number) => number> = {
        precipitation_sum: fromToday(climateOf.forecastRain, 0),
        temperature_2m_max: fromToday(climateOf.forecastTmax, 30),
        temperature_2m_min: () => 15,
        precipitation_probability_max: () => 80,
        wind_gusts_10m_max: () => 20,
      };
      const hours = time.flatMap((date) =>
        Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, "0")}:00`),
      );
      return respond("forecast", {
        ...daily(
          time,
          Object.fromEntries(dailyVariables.map((name) => [name, calm[name] ?? (() => 10)])),
        ),
        ...(hourlyVariables.length > 0
          ? {
              hourly: {
                time: hours,
                ...Object.fromEntries(hourlyVariables.map((name) => [name, hours.map(() => 0.3)])),
              },
            }
          : {}),
      });
    },

    floodForecast() {
      const today = istDate(now());
      const base = climateOf.riverDischarge ?? 0;
      const past = CLIMATE.floodForecastPastDays;
      const flow = (_date: string, i: number) => climateOf.forecastDischarge[i - past] ?? base;
      return respond(
        "flood_forecast",
        daily(dateRange(addDays(today, -past), addDays(today, 29)), {
          river_discharge: flow,
          river_discharge_median: (date, i) => flow(date, i) * 0.8,
          river_discharge_p75: (date, i) => flow(date, i) * 0.9,
          river_discharge_max: (date, i) => flow(date, i) * 1.2,
        }),
      );
    },

    status: () => ({ state: "unknown", checked_at: null }),
  };
}
