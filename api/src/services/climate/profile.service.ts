import { createHash } from "node:crypto";
import { CLIMATE } from "../../config/climate.js";
import { AppError, NotFoundError } from "../../errors/app-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { parseCellId, snapPoint, type Cell, type Cells } from "./grid.js";
import {
  ARCHIVE_VARIABLES,
  CLIMATE_VARIABLES,
  FLOOD_FORECAST_VARIABLES,
  forecastVariables,
} from "./hazards.js";
import { parsePayload, type OpenMeteoClient, type UpstreamResult } from "./open-meteo.js";
import { createRepository } from "./repository.js";
import { climateProfileSchema, type ClimateProfile } from "./schema.js";
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
  type DataQuality,
} from "./scoring.js";
import { screenRiver, screenWeather } from "./screening.js";
import {
  computeProjectionDeltas,
  computeRiverIndicators,
  computeWeatherIndicators,
  dailyMeans,
  mean,
} from "./stats.js";
import {
  HAZARDS,
  WEATHER_HAZARDS,
  storedIndicatorsSchema,
  type CacheResult,
  type CurrentData,
  type Hazard,
  type HazardProfile,
  type LatLon,
  type Relevance,
  type StaticFeatures,
  type TimeSeries,
} from "./types.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 5.5 * HOUR_MS;
// `issued_at` for observed and projection metrics, which have no issue time
const EPOCH = new Date(0);

// Flood exposure share (0-1) at a point, from the World Bank raster. Returns
// null when no raster is loaded, which is the case until one is wired in.
export type ExposureProvider = (point: LatLon) => Promise<number | null>;

export interface ClimateServiceDeps {
  prisma: PrismaClient;
  openMeteo: OpenMeteoClient;
  exposure?: ExposureProvider;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
}

export interface ClimateService {
  getProfile(point: LatLon, requesterId?: string | null): Promise<ClimateProfile>;
  getCell(cellId: string): Promise<unknown>;
}

interface Layer {
  data: UpstreamResult | null;
  fetchedAt: Date | null;
  responseId: number | null;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export const istDate = (date: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CLIMATE.timezone }).format(date);

const toIstIso = (date: Date) =>
  `${new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

export const addDays = (isoDate: string, days: number) =>
  new Date(Date.parse(isoDate) + days * DAY_MS).toISOString().slice(0, 10);

const paramsHash = (variables: string[]) =>
  createHash("sha256").update(JSON.stringify(variables)).digest("hex").slice(0, 16);

function window(data: TimeSeries, start: string, end: string): TimeSeries {
  const keep = data.time.map((date) => date >= start && date <= end);
  const values: TimeSeries["values"] = {};
  for (const [name, series] of Object.entries(data.values)) {
    values[name] = series.filter((_, i) => keep[i]);
  }
  return { time: data.time.filter((_, i) => keep[i]), values };
}

export function createClimateService(deps: ClimateServiceDeps): ClimateService {
  const repo = createRepository(deps.prisma);
  const om = deps.openMeteo;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const exposure: ExposureProvider = deps.exposure ?? (() => Promise.resolve(null));

  let catalogSeeded: Promise<void> | null = null;
  function ensureCatalog(): Promise<void> {
    catalogSeeded ??= repo.seedHazardCatalog().catch((error: unknown) => {
      catalogSeeded = null;
      throw error;
    });
    return catalogSeeded;
  }

  // Per-cell lock: requests for the same cells run one at a time, so two
  // simultaneous misses share one screening instead of both fetching.
  // In-process only; several API instances would need a shared lock.
  const tails = new Map<string, Promise<unknown>>();
  async function withCellLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  async function exposureAt(point: LatLon): Promise<number | null> {
    try {
      return await exposure(point);
    } catch (error) {
      logger.warn("flood exposure lookup failed", error);
      return null;
    }
  }

  async function run(
    point: LatLon,
    cells: Cells,
    requesterId: string | null,
    startedAt: number,
  ): Promise<ClimateProfile> {
    const at = now();
    const today = istDate(at);
    const warnings = new Set<string>();
    const quality: DataQuality = {
      staleServed: false,
      primaryMissing: false,
      secondaryMissing: false,
    };
    let upstreamCalls = 0;
    let miss = false;

    const call = <T>(request: () => Promise<T>): Promise<T> => {
      upstreamCalls += 1;
      return request();
    };

    // A failed write never fails the request: retry once, then log and move on
    async function write<T>(label: string, action: () => Promise<T>): Promise<T | null> {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await action();
        } catch (error) {
          if (attempt === 2) {
            logger.error(`climate: saving ${label} failed`, error);
            warnings.add("persistence_failed: some results were not saved");
          }
        }
      }
      return null;
    }

    await ensureCatalog();
    const pointRow = await repo.ensurePoint(point, cells);
    const rows = await repo.getRelevance([cells.historical.id, cells.flood.id]);

    function cachedProfiles(cellId: string, hazards: readonly Hazard[]) {
      const profiles: HazardProfile[] = [];
      let fresh = true;
      let decidedAt = at;
      let reviewAt = at;
      for (const hazard of hazards) {
        const row = rows.find((r) => r.cellId === cellId && r.hazard === hazard);
        const indicators = storedIndicatorsSchema.safeParse(row?.indicators);
        if (!row || !indicators.success) continue;
        if (row.reviewAfter <= at) fresh = false;
        decidedAt = row.decidedAt;
        reviewAt = row.reviewAfter;
        profiles.push({
          hazard,
          relevance: row.relevance,
          method: row.method,
          indicatorValue: row.indicatorValue,
          reason: row.rationale ?? "",
          indicators: indicators.data,
        });
      }
      const complete = profiles.length === hazards.length;
      return { profiles, complete, fresh: complete && fresh, decidedAt, reviewAt };
    }

    const reviewAfter = (complete: boolean) =>
      new Date(
        at.getTime() +
          (complete ? CLIMATE.rescreenDays : CLIMATE.degradedRescreenDays) * DAY_MS,
      );

    async function saveHistory(
      cell: Cell,
      api: string,
      variables: string[],
      result: UpstreamResult,
      kind: "observed" | "projection",
    ): Promise<void> {
      const responseId = await repo.saveResponse({
        cellId: cell.id,
        api,
        variables,
        paramsHash: paramsHash(variables),
        payload: result.payload,
        fetchedAt: at,
        staleAfter: null,
      });
      if (result.daily) await repo.insertMetrics(cell.id, result.daily, kind, EPOCH, responseId);
    }

    // --- Fetch 1: climate projections ---
    // A secondary layer that can fill in late. Open-Meteo counts the archive
    // and climate APIs against one per-minute limit and a 30-year request
    // uses all of it, so on the free tier both cannot succeed in one minute.
    async function fetchProjections() {
      try {
        const result = await call(() =>
          om.climate(
            cells.climate,
            CLIMATE.projectionBaseline.start,
            CLIMATE.projectionFuture.end,
          ),
        );
        if (!result.daily) throw new Error("projections have no daily block");
        return { result, deltas: computeProjectionDeltas(result.daily) };
      } catch (error) {
        logger.warn("climate: projections failed", error);
        warnings.add("climate_projections_unavailable: no projection adjustment applied yet");
        quality.secondaryMissing = true;
        return null;
      }
    }

    type Projections = Awaited<ReturnType<typeof fetchProjections>>;

    // Sets each hazard's adjustment, or schedules another try if there is none
    function withProjections(profile: HazardProfile, projections: Projections): HazardProfile {
      const { projectionsRetryAt: _previous, ...indicators } = profile.indicators;
      return {
        ...profile,
        indicators: {
          ...indicators,
          projectionAdjustment: projectionAdjustment(profile.hazard, projections?.deltas ?? null),
          ...(projections
            ? {}
            : {
                projectionsRetryAt: new Date(
                  at.getTime() + CLIMATE.projectionRetryMinutes * 60_000,
                ).toISOString(),
              }),
        },
      };
    }

    async function saveWeatherProfiles(
      profiles: HazardProfile[],
      projections: Projections,
      decidedAt: Date,
      reviewAt: Date,
    ): Promise<void> {
      if (projections) {
        await saveHistory(cells.climate, "climate", CLIMATE_VARIABLES, projections.result, "projection");
      }
      await repo.saveRelevance(cells.historical.id, profiles, {
        confidence: projections ? "high" : "med",
        decidedAt,
        reviewAfter: reviewAt,
        ruleVersion: CLIMATE.ruleVersion,
      });
    }

    // --- Fetch 1 + screening: weather hazards (0.1 degree history) ---
    async function weatherProfiles(): Promise<HazardProfile[]> {
      const cached = cachedProfiles(cells.historical.id, WEATHER_HAZARDS);
      if (cached.fresh) {
        const retryAt = cached.profiles[0]?.indicators.projectionsRetryAt;
        if (!retryAt) return cached.profiles;
        if (at < new Date(retryAt)) {
          warnings.add("climate_projections_unavailable: no projection adjustment applied yet");
          quality.secondaryMissing = true;
          return cached.profiles;
        }
        // Screening is done; only the projections are still owed
        const projections = await fetchProjections();
        const profiles = cached.profiles.map((p) => withProjections(p, projections));
        await write("projections", () =>
          saveWeatherProfiles(profiles, projections, cached.decidedAt, cached.reviewAt),
        );
        return profiles;
      }
      miss = true;

      let archive: UpstreamResult | null = null;
      try {
        archive = await call(() =>
          om.archive(
            cells.historical,
            CLIMATE.historyStart,
            addDays(today, -(CLIMATE.era5DelayDays + 1)),
          ),
        );
      } catch (error) {
        logger.warn("climate: archive failed", error);
      }

      const history = archive?.daily ?? null;
      if (!archive || !history) {
        if (cached.complete) {
          warnings.add("historical_weather_unavailable: using an expired relevance profile");
          quality.staleServed = true;
          return cached.profiles;
        }
        throw new AppError(
          "Climate data sources are unavailable",
          503,
          "UPSTREAM_UNAVAILABLE",
          undefined,
          "fetch_screening",
        );
      }

      // After the archive, never alongside it: they share a rate limit
      const projections = await fetchProjections();
      const indicators = computeWeatherIndicators(history);
      const screened = screenWeather(indicators);
      const profiles = WEATHER_HAZARDS.map((hazard) =>
        withProjections(
          {
            hazard,
            relevance: screened[hazard].relevance,
            method: "static",
            indicatorValue: screened[hazard].indicatorValue,
            reason: screened[hazard].reason,
            indicators: {
              weather: indicators,
              primaryThreshold: screened[hazard].primaryThreshold,
              projectionAdjustment: 0,
            },
          },
          projections,
        ),
      );

      const screenedArchive = archive;
      await write("weather screening", async () => {
        await saveHistory(cells.historical, "archive", ARCHIVE_VARIABLES, screenedArchive, "observed");
        await saveWeatherProfiles(profiles, projections, at, reviewAfter(true));
      });
      return profiles;
    }

    // --- Fetch 1 + screening: river flood (0.05 degree discharge history) ---
    async function riverProfile(): Promise<HazardProfile> {
      const cached = cachedProfiles(cells.flood.id, ["river_flood"]);
      const cachedProfile = cached.profiles[0];
      if (cached.fresh && cachedProfile) return cachedProfile;
      miss = true;

      let history: UpstreamResult | null = null;
      try {
        history = await call(() => om.floodHistory(cells.flood, CLIMATE.historyStart, today));
      } catch (error) {
        logger.warn("climate: river discharge history failed", error);
        if (cachedProfile) {
          warnings.add("river_discharge_history_unavailable: using an expired relevance profile");
          quality.staleServed = true;
          return cachedProfile;
        }
        warnings.add("river_discharge_history_unavailable: river flood treated as secondary");
        quality.primaryMissing = true;
      }

      const river = history?.daily ? computeRiverIndicators(history.daily) : null;
      const screened = screenRiver(river, await exposureAt(cells.flood), history === null);
      const profile: HazardProfile = {
        hazard: "river_flood",
        relevance: screened.relevance,
        method: "static",
        indicatorValue: screened.indicatorValue,
        reason: screened.reason,
        indicators: {
          river,
          primaryThreshold: screened.primaryThreshold,
          projectionAdjustment: 0,
        },
      };

      await write("river screening", async () => {
        if (history) {
          await saveHistory(cells.flood, "flood_history", ["river_discharge"], history, "observed");
        }
        await repo.saveRelevance(cells.flood.id, [profile], {
          confidence: history ? "high" : "low",
          decidedAt: at,
          reviewAfter: reviewAfter(history !== null),
          ruleVersion: CLIMATE.ruleVersion,
        });
      });
      return profile;
    }

    // --- Fetch 1: static features of the exact point ---
    async function staticFeatures(): Promise<StaticFeatures> {
      if (pointRow.staticFeatures) return pointRow.staticFeatures;

      const d = CLIMATE.elevationNeighbourDeg;
      const dLon = d / Math.cos((point.lat * Math.PI) / 180);
      const ring: LatLon[] = [];
      for (const i of [-1, 0, 1]) {
        for (const j of [-1, 0, 1]) {
          if (i !== 0 || j !== 0) ring.push({ lat: point.lat + i * d, lon: point.lon + j * dLon });
        }
      }

      let elevations: number[];
      try {
        elevations = await call(() => om.elevation([point, ...ring]));
      } catch (error) {
        logger.warn("climate: elevation failed", error);
        warnings.add("elevation_unavailable: structural score computed without it");
        quality.secondaryMissing = true;
        // Not saved, so the next request for this point tries again
        return { elevationM: null, relativeElevationM: null, floodExposureShare: null };
      }

      const elevationM = elevations[0] ?? null;
      const surroundings = mean(elevations.slice(1));
      const features: StaticFeatures = {
        elevationM,
        relativeElevationM:
          elevationM === null || surroundings === null ? null : elevationM - surroundings,
        floodExposureShare: await exposureAt(point),
      };
      await write("static features", () =>
        repo.saveStatic(pointRow.id, features, CLIMATE.staticSourceVersion, at),
      );
      return features;
    }

    // --- Fetch 2: a forecast layer, refetched only when stale ---
    async function layer(spec: {
      cell: Cell;
      api: string;
      variables: string[];
      staleHours: number;
      fetch: () => Promise<UpstreamResult>;
      metrics: (result: UpstreamResult) => TimeSeries | null;
    }): Promise<Layer> {
      const hash = paramsHash(spec.variables);
      const cached = await repo.getResponse(spec.cell.id, spec.api, hash);

      const fromCache = (): Layer | null => {
        if (!cached) return null;
        try {
          return {
            data: parsePayload(spec.api, cached.response),
            fetchedAt: cached.fetchedAt,
            responseId: cached.id,
          };
        } catch {
          return null;
        }
      };

      if (cached?.staleAfter && cached.staleAfter > at) {
        const hit = fromCache();
        if (hit) return hit;
      }

      try {
        const result = await call(spec.fetch);
        const responseId = await write(`${spec.api} response`, async () => {
          const id = await repo.saveResponse({
            cellId: spec.cell.id,
            api: spec.api,
            variables: spec.variables,
            paramsHash: hash,
            payload: result.payload,
            fetchedAt: at,
            staleAfter: new Date(at.getTime() + spec.staleHours * HOUR_MS),
          });
          const metrics = spec.metrics(result);
          if (metrics) await repo.insertMetrics(spec.cell.id, metrics, "forecast", at, id);
          return id;
        });
        return { data: result, fetchedAt: at, responseId };
      } catch (error) {
        logger.warn(`climate: ${spec.api} failed`, error);
        const stale = fromCache();
        if (stale?.fetchedAt && cached) {
          warnings.add(
            `${spec.api}_unavailable: serving cached data from ${toIstIso(stale.fetchedAt)}`,
          );
          quality.staleServed = true;
          await write("stale marker", () => repo.markStale(cached.id));
          return stale;
        }
        warnings.add(`${spec.api}_unavailable: forecast signal left out`);
        quality.primaryMissing = true;
        return { data: null, fetchedAt: null, responseId: null };
      }
    }

    const [weather, river, features] = await Promise.all([
      weatherProfiles(),
      riverProfile(),
      staticFeatures(),
    ]);

    const profiles = Object.fromEntries(
      [...weather, river].map((profile) => [profile.hazard, profile]),
    ) as Record<Hazard, HazardProfile>;
    const relevance = Object.fromEntries(
      HAZARDS.map((hazard) => [hazard, profiles[hazard].relevance]),
    ) as Record<Hazard, Relevance>;

    if (features.floodExposureShare === null) {
      warnings.add("flood_exposure_unavailable: World Bank exposure raster is not loaded");
      quality.secondaryMissing = true;
    }

    const variables = forecastVariables(relevance);
    const soilMoisture = (result: UpstreamResult) => {
      const hourly = result.hourly?.values.soil_moisture_9_to_27cm;
      return hourly && result.hourly ? dailyMeans(result.hourly.time, hourly) : null;
    };
    // Daily forecast plus soil moisture, which arrives hourly, as daily means
    const forecastSeries = (result: UpstreamResult): TimeSeries | null => {
      if (!result.daily) return null;
      const soil = soilMoisture(result);
      if (!soil) return result.daily;
      const byDay = new Map(soil.time.map((day, i) => [day, soil.values[i] ?? null]));
      return {
        time: result.daily.time,
        values: {
          ...result.daily.values,
          soil_moisture_9_to_27cm: result.daily.time.map((day) => byDay.get(day) ?? null),
        },
      };
    };

    const [forecast, floodForecast] = await Promise.all([
      layer({
        cell: cells.forecast,
        api: "forecast",
        variables: [...variables.daily, ...variables.hourly.map((v) => `hourly:${v}`)],
        staleHours: CLIMATE.staleForecastHours,
        fetch: () => om.forecast(cells.forecast, variables.daily, variables.hourly),
        metrics: forecastSeries,
      }),
      // Call 6 is skipped while river flood is dormant
      relevance.river_flood === "dormant"
        ? null
        : layer({
            cell: cells.flood,
            api: "flood_forecast",
            variables: FLOOD_FORECAST_VARIABLES,
            staleHours: CLIMATE.staleFloodHours,
            fetch: () => om.floodForecast(cells.flood),
            metrics: (result) => result.daily,
          }),
    ]);

    const windowEnd = addDays(today, CLIMATE.eventWindowDays - 1);
    const weatherSeries = forecast.data ? forecastSeries(forecast.data) : null;
    const current: CurrentData = {
      weather: weatherSeries ? window(weatherSeries, today, windowEnd) : null,
      flood: floodForecast?.data?.daily
        ? window(floodForecast.data.daily, today, windowEnd)
        : null,
    };

    // --- Score ---
    const events = detectEvents(profiles, current);
    const hazards = HAZARDS.map((hazard) => {
      const profile = profiles[hazard];
      // Tripwire: a dormant hazard with an active event is raised for now
      const promoted = profile.relevance === "dormant" && events.some((e) => e.hazard === hazard);
      const components = {
        structural: structuralScore(hazard, features),
        historical: historicalScore(profile),
        forecast: forecastScore(profile, current),
      };
      return {
        hazard,
        relevance: promoted ? ("secondary" as const) : profile.relevance,
        promoted,
        method: profile.method,
        components,
        score: hazardScore(components, profile.indicators.projectionAdjustment),
        reason: profile.reason,
      };
    });
    const overall = round(overallRisk(hazards));
    const cache: CacheResult = miss ? "miss" : upstreamCalls > 0 ? "partial_hit" : "complete_hit";

    // --- Save ---
    if (cache !== "complete_hit") {
      await write("hazard scores", () =>
        repo.saveScores(
          pointRow.id,
          hazards.map((h) => ({
            hazard: h.hazard,
            relevance: h.relevance,
            score: h.score,
            ...h.components,
          })),
          at,
          CLIMATE.modelVersion,
        ),
      );
    }
    await write("events", () =>
      repo.syncEvents(
        [
          ...(current.weather
            ? (["flash_flood", "heat", "storm", "cold_wave"] as const).map((hazard) => ({
                hazard,
                cellId: cells.forecast.id,
                responseId: forecast.responseId,
              }))
            : []),
          ...(current.flood
            ? [
                {
                  hazard: "river_flood" as const,
                  cellId: cells.flood.id,
                  responseId: floodForecast?.responseId ?? null,
                },
              ]
            : []),
        ],
        events,
      ),
    );
    await write("request log", () =>
      repo.logRequest({
        pointId: pointRow.id,
        requesterId,
        cacheResult: cache,
        latencyMs: Math.round(performance.now() - startedAt),
      }),
    );

    // --- Build and validate the response ---
    const profile = {
      location: {
        lat: point.lat,
        lon: point.lon,
        cells: {
          historical: cells.historical.id,
          climate: cells.climate.id,
          flood: cells.flood.id,
          forecast: cells.forecast.id,
        },
      },
      overall_climate_risk: overall,
      grade: grade(overall),
      confidence: confidenceLevel(quality),
      hazards: hazards.map((h) => ({
        hazard: h.hazard,
        relevance: h.relevance,
        relevance_method: h.method,
        ...(h.promoted ? { tripwire_promoted: true as const } : {}),
        score: round(h.score),
        components: {
          ...(h.components.structural === null
            ? {}
            : { structural: round(h.components.structural) }),
          historical: round(h.components.historical),
          forecast: round(h.components.forecast),
        },
        reason: h.reason,
      })),
      active_events: events.map((event) => ({
        hazard: event.hazard,
        severity: event.severity,
        window_start: event.windowStart,
        window_end: event.windowEnd,
        confidence: round(event.confidence),
      })),
      data_freshness: {
        forecast_issued_at: forecast.fetchedAt ? toIstIso(forecast.fetchedAt) : null,
        history_until: profiles.heat.indicators.weather?.historyUntil ?? null,
      },
      cache,
      warnings: [...warnings],
    };

    const checked = climateProfileSchema.safeParse(profile);
    if (!checked.success) {
      logger.error("climate: profile failed output validation", {
        issues: checked.error.issues,
        profile,
      });
      throw new AppError(
        "Generated profile failed validation",
        500,
        "INVALID_OUTPUT",
        undefined,
        "output_validation",
      );
    }
    return checked.data;
  }

  return {
    getProfile(point, requesterId = null) {
      const startedAt = performance.now();
      const cells = snapPoint(point.lat, point.lon);
      return withCellLock(`${cells.historical.id}|${cells.flood.id}`, () =>
        run(point, cells, requesterId, startedAt),
      );
    },

    async getCell(cellId) {
      if (!parseCellId(cellId)) {
        throw new AppError(
          'cell_id must look like "0.05:26.15:91.75"',
          400,
          "INVALID_CELL_ID",
          undefined,
          "input_validation",
        );
      }
      const cell = await repo.getCellDebug(cellId);
      if (!cell) throw new NotFoundError(`Cell ${cellId} has no data yet`);
      return cell;
    },
  };
}
