import { createHash } from "node:crypto";
import { CLIMATE } from "../../config/climate.js";
import { AppError, NotFoundError } from "../../errors/app-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { noopCache, type Cache } from "../cache/cache.js";
import { applyReview, type ClimateAgent, type ForecastScores } from "./agent.js";
import { parseCellId, snapPoint, type Cell, type Cells } from "./grid.js";
import {
  ARCHIVE_VARIABLES,
  CLIMATE_VARIABLES,
  FLOOD_FORECAST_VARIABLES,
  HAZARD_CATALOG,
  forecastVariables,
} from "./hazards.js";
import { parsePayload, type OpenMeteoClient, type UpstreamResult } from "./open-meteo.js";
import { createRepository } from "./repository.js";
import {
  cachedForecastScoresSchema,
  cachedLayerSchema,
  cachedRelevanceSchema,
  climateProfileSchema,
  type ClimateProfile,
} from "./schema.js";
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
import { createNewPlaceGate, type NewPlaceGate } from "./new-place-gate.js";
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
  type ConfidenceLevel,
  type CurrentData,
  type Hazard,
  type HazardProfile,
  type LatLon,
  type Relevance,
  type RiverIndicators,
  type StaticFeatures,
  type TimeSeries,
  type WeatherIndicators,
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
  // Redis in production. Postgres stays the durable copy, so a cold or
  // unreachable cache costs a query, never an upstream call.
  cache?: Cache;
  // Verifies hazard categories (fetch 1) and scores the forecast (fetch 2).
  // Without one the pipeline is rule-based only.
  agent?: ClimateAgent;
  exposure?: ExposureProvider;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
  // Per-user allowance of places that need their history downloaded;
  // CLIMATE.newPlaceLookups by default
  newPlaces?: NewPlaceGate;
}

export interface ProfileOptions {
  // Refetch the two forecast layers (weather and river) even while they are
  // fresh. History, projections, static features and screening stay cached.
  forceFreshForecast?: boolean;
  // Screen a cell seen for the first time on this many years of history
  // instead of from CLIMATE.historyStart. A cell already screened keeps its
  // screening until it is reviewed again.
  historyYears?: number;
}

// The daily values the forecast scores and events were computed from, for a
// caller that applies its own thresholds (the background monitor)
export interface ForecastDetail {
  window: { start: string; end: string };
  // Null when that forecast is unavailable or, for the river, skipped
  weather: TimeSeries | null;
  flood: TimeSeries | null;
  weatherHistory: WeatherIndicators | null;
  riverHistory: RiverIndicators | null;
}

export interface DetailedProfile {
  profile: ClimateProfile;
  forecast: ForecastDetail;
}

export interface ClimateService {
  getProfile(
    point: LatLon,
    requesterId?: string | null,
    options?: ProfileOptions,
  ): Promise<ClimateProfile>;
  getCell(cellId: string): Promise<unknown>;
}

export interface ClimateInspector {
  // The same pipeline as getProfile, also returning the forecast values
  getProfileWithForecast(
    point: LatLon,
    requesterId?: string | null,
    options?: ProfileOptions,
  ): Promise<DetailedProfile>;
}

export interface RefreshSummary {
  points: number;
  failed: number;
}

export interface ClimateRefresher {
  // Refetches the forecast layers of every known location, whatever their
  // age, and updates Postgres, the cache, scores and events from them.
  refreshAll(): Promise<RefreshSummary>;
}

interface RunOptions extends ProfileOptions {
  // Forecast layers fetched before this moment are refetched even if fresh
  refreshBefore?: Date;
  // Scheduled run, not a client request: nothing is added to request_log
  background?: boolean;
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

// Never earlier than CLIMATE.historyStart
export function historyStartFor(today: string, years?: number): string {
  if (!years) return CLIMATE.historyStart;
  const start = `${Number(today.slice(0, 4)) - years}-01-01`;
  return start > CLIMATE.historyStart ? start : CLIMATE.historyStart;
}

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

export function createClimateService(
  deps: ClimateServiceDeps,
): ClimateService & ClimateRefresher & ClimateInspector {
  const repo = createRepository(deps.prisma);
  const om = deps.openMeteo;
  const store = deps.cache ?? noopCache;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const exposure: ExposureProvider = deps.exposure ?? (() => Promise.resolve(null));
  const newPlaces =
    deps.newPlaces ?? createNewPlaceGate({ ...CLIMATE.newPlaceLookups, now: () => now().getTime() });

  const agent = deps.agent;
  // Set after a failed agent call, so a broken key does not slow every request
  let agentDownUntil = 0;

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
    options: RunOptions = {},
  ): Promise<DetailedProfile> {
    const at = now();
    const today = istDate(at);
    const warnings = new Set<string>();
    const quality: DataQuality = {
      primaryMissing: false,
      secondaryMissing: false,
    };
    let upstreamCalls = 0;
    let miss = false;
    // Decided once per request: the weather and river downloads run side by
    // side, and a refusal must stop both
    let newPlaceRefusal: Error | null = null;
    let newPlaceChecked = false;
    const takeNewPlace = () => {
      if (!newPlaceChecked) {
        newPlaceChecked = true;
        try {
          newPlaces.take(requesterId);
        } catch (error) {
          newPlaceRefusal = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (newPlaceRefusal) throw newPlaceRefusal;
    };
    const historyStart = historyStartFor(today, options.historyYears);

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

    const relevanceKey = (cellId: string) => `climate:relevance:${cellId}`;

    // Screening results per cell: Redis first, Postgres for the cells it lacks
    async function loadRelevance(cellIds: string[]) {
      const found = await Promise.all(
        cellIds.map(async (cellId) => {
          const hit = cachedRelevanceSchema.safeParse(await store.get(relevanceKey(cellId)));
          return hit.success ? hit.data : null;
        }),
      );
      const missing = cellIds.filter((_, i) => !found[i]);
      const stored = missing.length > 0 ? await repo.getRelevance(missing) : [];
      for (const cellId of missing) {
        await rememberRelevance(cellId, stored.filter((row) => row.cellId === cellId));
      }
      return [...found.flatMap((rows) => rows ?? []), ...stored];
    }

    async function rememberRelevance(
      cellId: string,
      cellRows: Awaited<ReturnType<typeof repo.getRelevance>>,
    ): Promise<void> {
      const expiry = Math.min(...cellRows.map((row) => row.reviewAfter.getTime()));
      // Expired profiles are never served, so they are not cached
      if (cellRows.length > 0 && expiry > at.getTime()) {
        await store.set(relevanceKey(cellId), cellRows, expiry - at.getTime());
      } else {
        await store.del(relevanceKey(cellId));
      }
    }

    // Writes Postgres first, then refreshes the cache from what was stored
    async function saveRelevance(...args: Parameters<typeof repo.saveRelevance>): Promise<void> {
      await repo.saveRelevance(...args);
      await rememberRelevance(args[0], await repo.getRelevance([args[0]]));
    }

    const rows = await loadRelevance([...new Set([cells.historical.id, cells.flood.id])]);

    function cachedProfiles(cellId: string, hazards: readonly Hazard[]) {
      const profiles: HazardProfile[] = [];
      let fresh = true;
      let decidedAt = at;
      let reviewAt = at;
      let confidence: ConfidenceLevel = "high";
      for (const hazard of hazards) {
        const row = rows.find((r) => r.cellId === cellId && r.hazard === hazard);
        const indicators = storedIndicatorsSchema.safeParse(row?.indicators);
        if (!row || !indicators.success) continue;
        if (row.reviewAfter <= at) fresh = false;
        decidedAt = row.decidedAt;
        reviewAt = row.reviewAfter;
        confidence = row.confidence;
        profiles.push({
          hazard,
          relevance: row.relevance,
          method: row.method,
          indicatorValue: row.indicatorValue,
          reason: row.rationale ?? "",
          indicators: indicators.data,
          agentVersion: row.agentVersion,
        });
      }
      const complete = profiles.length === hazards.length;
      return { profiles, complete, fresh: complete && fresh, decidedAt, reviewAt, confidence };
    }

    const agentReady = () => agent !== undefined && at.getTime() >= agentDownUntil;

    function agentFailed(error: unknown, consequence: string): void {
      logger.warn("climate: agent call failed", error);
      warnings.add(`agent_unavailable: ${consequence}`);
      agentDownUntil = at.getTime() + CLIMATE.agent.retryMinutes * 60_000;
    }

    // --- Fetch 1: agent review of the screening ---
    // Confirms each category or raises it. If the call fails the profiles
    // stay unreviewed, so a later request asks again.
    async function review(list: HazardProfile[]): Promise<HazardProfile[]> {
      if (!agent || !agentReady() || list.every((profile) => profile.agentVersion)) return list;
      try {
        const verdicts = await call(() =>
          agent.reviewScreening({
            location: point,
            weatherHistory: list.find((p) => p.indicators.weather)?.indicators.weather ?? null,
            riverHistory: list.find((p) => p.indicators.river)?.indicators.river ?? null,
            hazards: list.map((profile) => ({
              hazard: profile.hazard,
              description: HAZARD_CATALOG[profile.hazard].description,
              indicatorRule: HAZARD_CATALOG[profile.hazard].indicatorRule,
              indicatorValue: profile.indicatorValue,
              primaryThreshold: profile.indicators.primaryThreshold,
              dormantThreshold: HAZARD_CATALOG[profile.hazard].dormantThreshold,
              ruleCategory: profile.relevance,
              ruleReason: profile.reason,
            })),
          }),
        );
        return list.map((profile) =>
          applyReview(profile, verdicts.find((v) => v.hazard === profile.hazard), agent.version),
        );
      } catch (error) {
        agentFailed(error, "hazard categories are rule-based only");
        return list;
      }
    }

    // Profiles cached before the agent saw them: screened while it was off
    // or failing. Reviewed in place, keeping their original review date.
    async function reviewCached(
      cellId: string,
      cached: ReturnType<typeof cachedProfiles>,
    ): Promise<HazardProfile[]> {
      const profiles = await review(cached.profiles);
      if (profiles !== cached.profiles) {
        await write("agent review", () =>
          saveRelevance(cellId, profiles, {
            confidence: cached.confidence,
            decidedAt: cached.decidedAt,
            reviewAfter: cached.reviewAt,
            ruleVersion: CLIMATE.ruleVersion,
          }),
        );
      }
      return profiles;
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
      await saveRelevance(cells.historical.id, profiles, {
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
        const known = await reviewCached(cells.historical.id, cached);
        const retryAt = known[0]?.indicators.projectionsRetryAt;
        if (!retryAt) return known;
        if (at < new Date(retryAt)) {
          warnings.add("climate_projections_unavailable: no projection adjustment applied yet");
          quality.secondaryMissing = true;
          return known;
        }
        // Screening is done; only the projections are still owed
        const projections = await fetchProjections();
        const profiles = known.map((p) => withProjections(p, projections));
        await write("projections", () =>
          saveWeatherProfiles(profiles, projections, cached.decidedAt, cached.reviewAt),
        );
        return profiles;
      }
      miss = true;
      takeNewPlace();

      let archive: UpstreamResult | null = null;
      try {
        archive = await call(() =>
          om.archive(
            cells.historical,
            historyStart,
            addDays(today, -(CLIMATE.era5DelayDays + 1)),
          ),
        );
      } catch (error) {
        logger.warn("climate: archive failed", error);
      }

      const history = archive?.daily ?? null;
      // An expired profile is never served in its place
      if (!archive || !history) {
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
      const screenedProfiles = WEATHER_HAZARDS.map((hazard) =>
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
      const profiles = await review(screenedProfiles);

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
      if (cached.fresh && cachedProfile) {
        return (await reviewCached(cells.flood.id, cached))[0] ?? cachedProfile;
      }
      miss = true;
      takeNewPlace();

      let history: UpstreamResult | null = null;
      try {
        history = await call(() => om.floodHistory(cells.flood, historyStart, today));
      } catch (error) {
        logger.warn("climate: river discharge history failed", error);
        warnings.add("river_discharge_history_unavailable: river flood treated as secondary");
        quality.primaryMissing = true;
      }

      const river = history?.daily ? computeRiverIndicators(history.daily) : null;
      const screened = screenRiver(river, await exposureAt(cells.flood), history === null);
      const screenedProfile: HazardProfile = {
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
      const [profile = screenedProfile] = await review([screenedProfile]);

      await write("river screening", async () => {
        if (history) {
          await saveHistory(cells.flood, "flood_history", ["river_discharge"], history, "observed");
        }
        await saveRelevance(cells.flood.id, [profile], {
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
      const cacheKey = `climate:response:${spec.api}:${spec.cell.id}:${hash}`;
      const remember = (payload: unknown, fetchedAt: Date, staleAfter: Date, responseId: number | null) =>
        store.set(
          cacheKey,
          { payload, fetchedAt, staleAfter, responseId },
          staleAfter.getTime() - at.getTime(),
        );

      // During a scheduled refresh a layer only counts if this run fetched it,
      // so each cell is refetched once however many locations share it
      const current = (fetchedAt: Date) =>
        !options.forceFreshForecast &&
        (!options.refreshBefore || fetchedAt >= options.refreshBefore);

      const hit = cachedLayerSchema.safeParse(await store.get(cacheKey));
      if (hit.success && hit.data.staleAfter > at && current(hit.data.fetchedAt)) {
        try {
          return {
            data: parsePayload(spec.api, hit.data.payload),
            fetchedAt: hit.data.fetchedAt,
            responseId: hit.data.responseId,
          };
        } catch {
          // Unreadable entry: fall through to Postgres and overwrite it
        }
      }

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

      if (cached?.staleAfter && cached.staleAfter > at && current(cached.fetchedAt)) {
        const stored = fromCache();
        if (stored) {
          await remember(cached.response, cached.fetchedAt, cached.staleAfter, cached.id);
          return stored;
        }
      }

      try {
        const result = await call(spec.fetch);
        const staleAfter = new Date(at.getTime() + spec.staleHours * HOUR_MS);
        const responseId = await write(`${spec.api} response`, async () => {
          const id = await repo.saveResponse({
            cellId: spec.cell.id,
            api: spec.api,
            variables: spec.variables,
            paramsHash: hash,
            payload: result.payload,
            fetchedAt: at,
            staleAfter,
          });
          const metrics = spec.metrics(result);
          if (metrics) await repo.insertMetrics(spec.cell.id, metrics, "forecast", at, id);
          return id;
        });
        await remember(result.payload, at, staleAfter, responseId);
        return { data: result, fetchedAt: at, responseId };
      } catch (error) {
        logger.warn(`climate: ${spec.api} failed`, error);
        // A failed scheduled refresh leaves a layer that is still valid alone.
        // One past its `staleAfter` is never served.
        const valid = cached?.staleAfter && cached.staleAfter > at ? fromCache() : null;
        if (valid) return valid;
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

    // --- Fetch 2: agent score for the forecast window ---
    // Asked once per forecast refresh; the answer is cached beside the
    // forecast, so a complete hit never calls the model.
    const ruleForecast = Object.fromEntries(
      HAZARDS.map((hazard) => [hazard, forecastScore(profiles[hazard], current)]),
    ) as Record<Hazard, number>;

    async function agentForecast(): Promise<ForecastScores | null> {
      if (!agent || (!current.weather && !current.flood)) return null;
      const basis = [agent.version, forecast.fetchedAt, floodForecast?.fetchedAt ?? null, relevance];
      const key = `climate:agent-forecast:${cells.forecast.id}:${cells.flood.id}:${createHash(
        "sha256",
      )
        .update(JSON.stringify(basis))
        .digest("hex")
        .slice(0, 16)}`;

      const hit = cachedForecastScoresSchema.safeParse(await store.get(key));
      if (hit.success && HAZARDS.every((hazard) => hit.data[hazard])) {
        return hit.data;
      }
      if (!agentReady()) {
        warnings.add("agent_unavailable: forecast scores are rule-based only");
        return null;
      }
      try {
        const scores = await call(() =>
          agent.scoreForecast({
            location: point,
            window: { start: today, end: windowEnd },
            weatherHistory: profiles.heat.indicators.weather ?? null,
            riverHistory: profiles.river_flood.indicators.river ?? null,
            weather: current.weather,
            flood: current.flood,
            hazards: HAZARDS.map((hazard) => ({
              hazard,
              category: relevance[hazard],
              ruleScore: round(ruleForecast[hazard]),
            })),
          }),
        );
        await store.set(key, scores, CLIMATE.staleFloodHours * HOUR_MS);
        return scores;
      } catch (error) {
        agentFailed(error, "forecast scores are rule-based only");
        return null;
      }
    }
    const agentScores = await agentForecast();

    // --- Score ---
    const events = detectEvents(profiles, current);
    const hazards = HAZARDS.map((hazard) => {
      const profile = profiles[hazard];
      // Tripwire: a dormant hazard with an active event is raised for now
      const promoted = profile.relevance === "dormant" && events.some((e) => e.hazard === hazard);
      const components = {
        structural: structuralScore(hazard, features),
        historical: historicalScore(profile),
        forecast: agentScores?.[hazard].score ?? ruleForecast[hazard],
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
    if (!options.background) {
      await write("request log", () =>
        repo.logRequest({
          pointId: pointRow.id,
          requesterId,
          cacheResult: cache,
          latencyMs: Math.round(performance.now() - startedAt),
        }),
      );
    }

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
        ...(agentScores
          ? { forecast_source: "agent" as const, forecast_note: agentScores[h.hazard].note }
          : {}),
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
    return {
      profile: checked.data,
      forecast: {
        window: { start: today, end: windowEnd },
        weather: current.weather,
        flood: current.flood,
        weatherHistory: profiles.heat.indicators.weather ?? null,
        riverHistory: profiles.river_flood.indicators.river ?? null,
      },
    };
  }

  const lockKey = (cells: Cells) => `${cells.historical.id}|${cells.flood.id}`;

  // Every request takes the cell lock, whether it turns out to be a miss, a
  // partial hit or a complete hit
  function locked(
    point: LatLon,
    requesterId: string | null,
    options: ProfileOptions,
  ): Promise<DetailedProfile> {
    const startedAt = performance.now();
    const cells = snapPoint(point.lat, point.lon);
    return withCellLock(lockKey(cells), () =>
      run(point, cells, requesterId, startedAt, {
        forceFreshForecast: options.forceFreshForecast ?? false,
        historyYears: options.historyYears,
      }),
    );
  }

  return {
    async getProfile(point, requesterId = null, options = {}) {
      return (await locked(point, requesterId, options)).profile;
    },

    getProfileWithForecast(point, requesterId = null, options = {}) {
      return locked(point, requesterId, options);
    },

    // One location at a time, to stay well inside the upstream rate limits.
    // A location that fails is logged and skipped; the rest still refresh.
    async refreshAll() {
      const refreshBefore = now();
      const points = await repo.listPoints();
      let failed = 0;
      for (const point of points) {
        const cells = snapPoint(point.lat, point.lon);
        try {
          await withCellLock(lockKey(cells), () =>
            run(point, cells, null, performance.now(), { refreshBefore, background: true }),
          );
        } catch (error) {
          failed += 1;
          logger.warn(`climate: refresh failed for ${point.lat},${point.lon}`, error);
        }
      }
      return { points: points.length, failed };
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
