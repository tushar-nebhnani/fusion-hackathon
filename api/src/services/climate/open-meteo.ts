import { z } from "zod";
import { CLIMATE } from "../../config/climate.js";
import {
  ARCHIVE_VARIABLES,
  CLIMATE_VARIABLES,
  FLOOD_FORECAST_VARIABLES,
} from "./hazards.js";
import type { LatLon, Series, TimeSeries } from "./types.js";

const HOSTS = {
  forecast: "https://api.open-meteo.com",
  archive: "https://archive-api.open-meteo.com",
  flood: "https://flood-api.open-meteo.com",
  climate: "https://climate-api.open-meteo.com",
} as const;

export class UpstreamError extends Error {
  readonly api: string;
  readonly status?: number;

  constructor(api: string, message: string, status?: number) {
    super(`${api}: ${message}`);
    this.name = "UpstreamError";
    this.api = api;
    this.status = status;
  }
}

const block = z.record(z.string(), z.array(z.union([z.number(), z.string(), z.null()])));

// Loose on purpose: the raw payload is stored as-is, so unknown keys such as
// units and model metadata are kept.
const payloadSchema = z.looseObject({
  daily: block.optional(),
  hourly: block.optional(),
  // A list from the Elevation API; a single number on every other response
  elevation: z.union([z.number(), z.array(z.number())]).optional(),
});
export type Payload = z.infer<typeof payloadSchema>;

export interface UpstreamResult {
  payload: Payload;
  daily: TimeSeries | null;
  hourly: TimeSeries | null;
}

function toTimeSeries(api: string, raw: Payload["daily"]): TimeSeries | null {
  if (!raw) return null;
  const time = raw.time;
  if (!time?.every((t): t is string => typeof t === "string")) {
    throw new UpstreamError(api, "response has no valid time axis");
  }
  const values: Record<string, Series> = {};
  for (const [name, list] of Object.entries(raw)) {
    if (name === "time") continue;
    if (list.length !== time.length || !list.every((v) => typeof v !== "string")) {
      throw new UpstreamError(api, `variable ${name} is malformed`);
    }
    values[name] = list;
  }
  return { time, values };
}

// Validates an upstream (or cached) payload before anything is computed from it
export function parsePayload(api: string, json: unknown): UpstreamResult {
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) throw new UpstreamError(api, "unexpected response shape");
  return {
    payload: parsed.data,
    daily: toTimeSeries(api, parsed.data.daily),
    hourly: toTimeSeries(api, parsed.data.hourly),
  };
}

export interface UpstreamStatus {
  state: "up" | "down" | "unknown";
  checked_at: string | null;
}

export interface OpenMeteoClient {
  // Elevation in metres for each point, in request order
  elevation(points: LatLon[]): Promise<number[]>;
  archive(point: LatLon, startDate: string, endDate: string): Promise<UpstreamResult>;
  floodHistory(point: LatLon, startDate: string, endDate: string): Promise<UpstreamResult>;
  climate(point: LatLon, startDate: string, endDate: string): Promise<UpstreamResult>;
  forecast(point: LatLon, daily: string[], hourly: string[]): Promise<UpstreamResult>;
  floodForecast(point: LatLon): Promise<UpstreamResult>;
  // Outcome of the most recent upstream call; no extra request is made
  status(): UpstreamStatus;
}

export interface OpenMeteoOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  backoffMs?: number;
}

type Params = Record<string, string | number>;

export function createOpenMeteoClient(options: OpenMeteoOptions = {}): OpenMeteoClient {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? CLIMATE.upstream.attempts;
  const backoffMs = options.backoffMs ?? CLIMATE.upstream.backoffMs;
  let lastStatus: UpstreamStatus = { state: "unknown", checked_at: null };

  async function attempt(api: string, url: URL, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new UpstreamError(api, "request failed or timed out");
    }
    if (!response.ok) {
      throw new UpstreamError(api, `responded with HTTP ${response.status}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new UpstreamError(api, "response was not valid JSON");
    }
  }

  // Timeouts, rate limits and 5xx are retried with backoff; other 4xx are not
  async function get(
    api: string,
    host: string,
    path: string,
    params: Params,
    timeoutMs: number = CLIMATE.upstream.timeoutMs,
  ): Promise<UpstreamResult> {
    const url = new URL(path, host);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(backoffMs * 2 ** (i - 1));
      try {
        const result = parsePayload(api, await attempt(api, url, timeoutMs));
        lastStatus = { state: "up", checked_at: new Date().toISOString() };
        return result;
      } catch (error) {
        lastError = error;
        const status = error instanceof UpstreamError ? error.status : undefined;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable) break;
      }
    }
    lastStatus = { state: "down", checked_at: new Date().toISOString() };
    throw lastError;
  }

  // Latitude always comes first
  const at = (point: LatLon): Params => ({ latitude: point.lat, longitude: point.lon });
  const list = (variables: string[]) => variables.join(",");

  return {
    async elevation(points) {
      const result = await get("elevation", HOSTS.forecast, "/v1/elevation", {
        latitude: points.map((p) => p.lat).join(","),
        longitude: points.map((p) => p.lon).join(","),
      });
      const elevation = result.payload.elevation;
      if (!Array.isArray(elevation) || elevation.length !== points.length) {
        throw new UpstreamError("elevation", "wrong number of elevations returned");
      }
      return elevation;
    },

    archive: (point, startDate, endDate) =>
      get(
        "archive",
        HOSTS.archive,
        "/v1/archive",
        {
          ...at(point),
          start_date: startDate,
          end_date: endDate,
          timezone: CLIMATE.timezone,
          models: "era5_seamless",
          daily: list(ARCHIVE_VARIABLES),
        },
        CLIMATE.upstream.historyTimeoutMs,
      ),

    floodHistory: (point, startDate, endDate) =>
      get(
        "flood_history",
        HOSTS.flood,
        "/v1/flood",
        { ...at(point), start_date: startDate, end_date: endDate, daily: "river_discharge" },
        CLIMATE.upstream.historyTimeoutMs,
      ),

    climate: (point, startDate, endDate) =>
      get(
        "climate",
        HOSTS.climate,
        "/v1/climate",
        {
          ...at(point),
          start_date: startDate,
          end_date: endDate,
          models: list([...CLIMATE.climateModels]),
          daily: list(CLIMATE_VARIABLES),
        },
        CLIMATE.upstream.historyTimeoutMs,
      ),

    forecast: (point, daily, hourly) =>
      get("forecast", HOSTS.forecast, "/v1/forecast", {
        ...at(point),
        forecast_days: CLIMATE.forecastDays,
        past_days: CLIMATE.forecastPastDays,
        timezone: CLIMATE.timezone,
        daily: list(daily),
        ...(hourly.length > 0 ? { hourly: list(hourly) } : {}),
      }),

    floodForecast: (point) =>
      get("flood_forecast", HOSTS.flood, "/v1/flood", {
        ...at(point),
        forecast_days: CLIMATE.floodForecastDays,
        past_days: CLIMATE.floodForecastPastDays,
        daily: list(FLOOD_FORECAST_VARIABLES),
      }),

    status: () => lastStatus,
  };
}
