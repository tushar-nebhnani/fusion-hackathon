import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { Cell, Cells } from "./grid.js";
import { HAZARD_CATALOG } from "./hazards.js";
import type {
  CacheResult,
  ConfidenceLevel,
  DetectedEvent,
  Hazard,
  HazardProfile,
  LatLon,
  Relevance,
  Severity,
  StaticFeatures,
  TimeSeries,
} from "./types.js";

type MetricKind = "observed" | "forecast" | "projection";

const SEVERITY_RANK: Record<Severity, number> = { watch: 0, warning: 1, severe: 2 };
const toDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);

export interface SavedResponse {
  cellId: string;
  api: string;
  variables: string[];
  paramsHash: string;
  payload: unknown;
  fetchedAt: Date;
  staleAfter: Date | null;
}

export interface ScoreRow {
  hazard: Hazard;
  relevance: Relevance;
  structural: number | null;
  historical: number;
  forecast: number;
  score: number;
}

export function createRepository(prisma: PrismaClient) {
  return {
    async seedHazardCatalog(): Promise<void> {
      for (const definition of Object.values(HAZARD_CATALOG)) {
        const data = {
          apis: definition.apis,
          screeningVariables: definition.screeningVariables,
          currentVariables: [
            ...definition.currentVariables,
            ...definition.currentHourlyVariables,
          ],
          indicatorRule: { description: definition.indicatorRule },
          primaryThreshold: definition.primaryThreshold,
          dormantThreshold: definition.dormantThreshold,
          tripwireVariables: definition.tripwireVariables,
        };
        await prisma.hazardCatalog.upsert({
          where: { hazard: definition.hazard },
          update: data,
          create: { hazard: definition.hazard, ...data },
        });
      }
    },

    async ensurePoint(point: LatLon, cells: Cells) {
      const unique = new Map<string, Cell>();
      for (const cell of [cells.historical, cells.climate, cells.flood, cells.forecast]) {
        unique.set(cell.id, cell);
      }
      await prisma.gridCell.createMany({
        data: [...unique.values()].map((cell) => ({
          id: cell.id,
          resolutionDeg: cell.resolution,
          latCenter: cell.lat,
          lonCenter: cell.lon,
        })),
        skipDuplicates: true,
      });
      return prisma.point.upsert({
        where: { lat_lon: { lat: point.lat, lon: point.lon } },
        update: {},
        create: {
          lat: point.lat,
          lon: point.lon,
          cellHistorical: cells.historical.id,
          cellClimate: cells.climate.id,
          cellFlood: cells.flood.id,
          cellForecast: cells.forecast.id,
        },
        include: { staticFeatures: true },
      });
    },

    getRelevance(cellIds: string[]) {
      return prisma.cellHazardRelevance.findMany({ where: { cellId: { in: cellIds } } });
    },

    async saveRelevance(
      cellId: string,
      profiles: HazardProfile[],
      meta: { confidence: ConfidenceLevel; decidedAt: Date; reviewAfter: Date; ruleVersion: string },
    ): Promise<void> {
      await prisma.$transaction(
        profiles.map((profile) => {
          const data = {
            relevance: profile.relevance,
            indicatorValue: profile.indicatorValue,
            indicators: profile.indicators as Prisma.InputJsonValue,
            method: profile.method,
            rationale: profile.reason,
            agentVersion: profile.agentVersion ?? null,
            confidence: meta.confidence,
            decidedAt: meta.decidedAt,
            reviewAfter: meta.reviewAfter,
            ruleVersion: meta.ruleVersion,
          };
          return prisma.cellHazardRelevance.upsert({
            where: { cellId_hazard: { cellId, hazard: profile.hazard } },
            update: data,
            create: { cellId, hazard: profile.hazard, ...data },
          });
        }),
      );
    },

    async saveResponse(saved: SavedResponse): Promise<number> {
      const data = {
        variablesRequested: saved.variables,
        response: saved.payload as Prisma.InputJsonValue,
        fetchedAt: saved.fetchedAt,
        staleAfter: saved.staleAfter,
        status: "fresh" as const,
      };
      const row = await prisma.climateResponse.upsert({
        where: {
          cellId_api_paramsHash: {
            cellId: saved.cellId,
            api: saved.api,
            paramsHash: saved.paramsHash,
          },
        },
        update: data,
        create: { cellId: saved.cellId, api: saved.api, paramsHash: saved.paramsHash, ...data },
        select: { id: true },
      });
      return row.id;
    },

    getResponse(cellId: string, api: string, paramsHash: string) {
      return prisma.climateResponse.findUnique({
        where: { cellId_api_paramsHash: { cellId, api, paramsHash } },
      });
    },

    // One statement per variable, run together; rows already stored are left
    // untouched, so re-fetching history never duplicates a day.
    async insertMetrics(
      cellId: string,
      data: TimeSeries,
      kind: MetricKind,
      issuedAt: Date,
      responseId: number | null,
    ): Promise<void> {
      await Promise.all(
        Object.entries(data.values).map(async ([variable, series]) => {
          const dates: string[] = [];
          const values: number[] = [];
          series.forEach((value, i) => {
            const date = data.time[i];
            if (value === null || !date) return;
            dates.push(date);
            values.push(value);
          });
          if (dates.length === 0) return;
          await prisma.$executeRaw`
            INSERT INTO climate_metrics (cell_id, date, variable, value, kind, issued_at, response_id)
            SELECT ${cellId}, t.d::date, ${variable}, t.v, ${kind}::"MetricKind", ${issuedAt}, ${responseId}::int
            FROM unnest(${dates}::text[], ${values}::float8[]) AS t(d, v)
            ON CONFLICT DO NOTHING`;
        }),
      );
    },

    async saveStatic(
      pointId: number,
      features: StaticFeatures,
      sourceVersion: string,
      computedAt: Date,
    ): Promise<void> {
      const data = { ...features, sourceVersion, computedAt };
      await prisma.pointStaticFeatures.upsert({
        where: { pointId },
        update: data,
        create: { pointId, ...data },
      });
    },

    async saveScores(
      pointId: number,
      rows: ScoreRow[],
      computedAt: Date,
      modelVersion: string,
    ): Promise<void> {
      await prisma.hazardScore.createMany({
        data: rows.map((row) => ({ pointId, computedAt, modelVersion, ...row })),
      });
    },

    // Brings stored events in line with what the latest forecast shows for
    // each evaluated hazard: opens, updates, escalates or closes.
    async syncEvents(
      evaluated: { hazard: Hazard; cellId: string; responseId: number | null }[],
      detected: DetectedEvent[],
    ): Promise<void> {
      for (const { hazard, cellId, responseId } of evaluated) {
        const event = detected.find((d) => d.hazard === hazard);
        const active = await prisma.cellEvent.findFirst({
          where: { cellId, hazard, status: { in: ["open", "escalated"] } },
          orderBy: { id: "desc" },
        });

        if (!event) {
          if (active) {
            await prisma.cellEvent.update({
              where: { id: active.id },
              data: { status: "closed" },
            });
          }
          continue;
        }

        const data = {
          severity: event.severity,
          windowStart: toDate(event.windowStart),
          windowEnd: toDate(event.windowEnd),
          confidence: event.confidence,
          sourceResponseId: responseId,
        };
        if (!active) {
          await prisma.cellEvent.create({ data: { cellId, hazard, ...data } });
          continue;
        }
        const escalated = SEVERITY_RANK[event.severity] > SEVERITY_RANK[active.severity];
        await prisma.cellEvent.update({
          where: { id: active.id },
          data: { ...data, status: escalated ? "escalated" : active.status },
        });
      }
    },

    // Every location the tool has been asked about
    listPoints(): Promise<LatLon[]> {
      return prisma.point.findMany({ select: { lat: true, lon: true }, orderBy: { id: "asc" } });
    },

    async logRequest(entry: {
      pointId: number;
      requesterId: string | null;
      cacheResult: CacheResult;
      latencyMs: number;
    }): Promise<void> {
      await prisma.requestLog.create({ data: entry });
    },

    // Debug view of one cell. Raw payloads are left out: they run to megabytes.
    async getCellDebug(cellId: string) {
      const cell = await prisma.gridCell.findUnique({ where: { id: cellId } });
      if (!cell) return null;
      const [relevance, responses, events, metricCount] = await Promise.all([
        prisma.cellHazardRelevance.findMany({ where: { cellId }, orderBy: { hazard: "asc" } }),
        prisma.climateResponse.findMany({
          where: { cellId },
          orderBy: { api: "asc" },
          select: {
            id: true,
            api: true,
            variablesRequested: true,
            fetchedAt: true,
            staleAfter: true,
            status: true,
          },
        }),
        prisma.cellEvent.findMany({
          where: { cellId, status: { in: ["open", "escalated"] } },
          orderBy: { windowStart: "asc" },
        }),
        prisma.climateMetric.count({ where: { cellId } }),
      ]);
      return { cell, relevance, responses, events, metricCount };
    },
  };
}

export type ClimateRepository = ReturnType<typeof createRepository>;
