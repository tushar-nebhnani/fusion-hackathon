import { pathToFileURL } from "node:url";
import { CLIMATE } from "../../../config/climate.js";
import { snapPoint } from "../grid.js";
import type { OpenMeteoClient } from "../open-meteo.js";
import { addDays, istDate } from "../profile.service.js";
import {
  storedIndicatorsSchema,
  type Relevance,
  type RiverIndicators,
  type TimeSeries,
} from "../types.js";
import type { Clock, RunLogger } from "./ports.js";
import type { MonitorRepo, StoredEvent } from "./repo.js";
import { baseTripwires, shortDate } from "./rules.js";
import { forecastValuesSchema, isHazard, type CellState, type MonitorSettings } from "./types.js";
import { findMissed, labelEvent } from "./verify.js";

// The daily verification job (npm run monitor:verify). It runs once and
// exits, so it can be scheduled with cron.
//
// For every forecast the monitor acted on, it looks up what was observed and
// labels the event `hit` or `false_alarm`. It also looks for observed
// extremes that nothing forecast and records them as `missed`. Forecast and
// observed numbers are kept side by side: training data for the ML model.

export interface VerifyDeps {
  repo: MonitorRepo;
  // The climate unit's stored screening, for a cell's river high
  relevance: {
    getRelevance(
      cellIds: string[],
    ): Promise<{ hazard: string; relevance: Relevance; indicators: unknown }[]>;
  };
  // The climate unit's historical fetchers: ERA5 archive and river discharge
  openMeteo: Pick<OpenMeteoClient, "archive" | "floodHistory">;
  clock: Clock;
  logger: RunLogger;
  settings: Pick<MonitorSettings, "rain" | "verify">;
}

export interface VerifySummary {
  cells: number;
  hit: number;
  falseAlarm: number;
  missed: number;
  // Events whose observed data is not complete yet
  waiting: number;
  failed: number;
}

export interface Verifier {
  run(): Promise<VerifySummary>;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const earliest = (dates: string[]) => dates.reduce((a, b) => (b < a ? b : a));
const latest = (a: string, b: string) => (b > a ? b : a);

export function createVerifier(deps: VerifyDeps): Verifier {
  const { repo, openMeteo, logger, settings } = deps;

  async function riverOf(floodCellId: string): Promise<RiverIndicators | null> {
    const rows = await deps.relevance.getRelevance([floodCellId]);
    const row = rows.find((r) => r.hazard === "river_flood" && r.relevance !== "dormant");
    const indicators = storedIndicatorsSchema.safeParse(row?.indicators);
    return indicators.success ? (indicators.data.river ?? null) : null;
  }

  async function verifyCell(
    cell: CellState,
    pending: StoredEvent[],
    until: string,
    summary: VerifySummary,
  ): Promise<void> {
    const now = deps.clock.now();
    // Only days on which the cell was actually being watched are scanned
    const scanFrom = cell.active
      ? latest(addDays(until, -(settings.verify.scanDays - 1)), istDate(cell.createdAt))
      : null;
    const scanning = scanFrom !== null && scanFrom <= until;
    if (pending.length === 0 && !scanning) return;
    summary.cells += 1;

    const from = earliest([
      ...pending.map((event) => event.windowStart),
      ...(scanning ? [scanFrom] : []),
    ]);
    const cells = snapPoint(cell.lat, cell.lon);
    const weather = (await openMeteo.archive(cells.historical, from, until)).daily;

    const river = await riverOf(cells.flood.id);
    let riverSeries: TimeSeries | null = null;
    if (river || pending.some((event) => event.hazard === "river_flood")) {
      try {
        riverSeries = (await openMeteo.floodHistory(cells.flood, from, until)).daily;
      } catch (error) {
        logger.warn(`${cell.cellId}: observed river discharge unavailable: ${describe(error)}`);
      }
    }
    const base = baseTripwires(river, settings);

    for (const event of pending) {
      const stored = forecastValuesSchema.safeParse(event.forecastValues);
      const tripwire =
        (stored.success ? stored.data.tripwire : null) ??
        (isHazard(event.hazard) ? base[event.hazard]?.tripwire : undefined);
      const label = tripwire
        ? labelEvent(event, tripwire, tripwire.variable === "river_discharge" ? riverSeries : weather)
        : null;
      if (!label) {
        summary.waiting += 1;
        continue;
      }
      await repo.labelEvent(event.eventId, label.status, { ...label.observed }, now);
      if (label.status === "hit") summary.hit += 1;
      else summary.falseAlarm += 1;
    }

    if (!scanning) return;
    const tolerance = settings.verify.matchToleranceDays;
    const missed = findMissed({
      tripwires: base,
      weather,
      river: riverSeries,
      from: scanFrom,
      to: until,
      events: await repo.eventsBetween(
        cell.cellId,
        addDays(scanFrom, -tolerance),
        addDays(until, tolerance),
      ),
      toleranceDays: tolerance,
    });
    for (const run of missed) {
      await repo.insertMissed(
        {
          cellId: cell.cellId,
          hazard: run.hazard,
          level: run.level,
          windowStart: run.windowStart,
          windowEnd: run.windowEnd,
          // Nothing was forecast; only the tripwire the observation crossed
          forecastValues: { tripwire: base[run.hazard]?.tripwire ?? null },
          evidence:
            `Observed ${run.observed.variable} of ${String(run.observed.peak)} on ` +
            `${shortDate(run.observed.peakDate ?? run.windowStart)} crossed ${String(run.observed.threshold)} ` +
            "with no forecast event",
          sourceRunId: null,
        },
        { ...run.observed },
        now,
      );
      summary.missed += 1;
    }
  }

  return {
    async run() {
      const summary: VerifySummary = { cells: 0, hit: 0, falseAlarm: 0, missed: 0, waiting: 0, failed: 0 };
      // The ERA5 archive runs about 5 days behind, so nothing newer is judged
      const until = addDays(istDate(deps.clock.now()), -CLIMATE.era5DelayDays);
      const pending = await repo.pendingEvents(until);

      // One cell at a time, to stay well inside the upstream rate limits.
      // A cell that fails is logged and skipped; its events stay pending.
      for (const cell of await repo.listCells()) {
        try {
          await verifyCell(cell, pending.filter((event) => event.cellId === cell.cellId), until, summary);
        } catch (error) {
          summary.failed += 1;
          logger.warn(`${cell.cellId}: verification failed, tried again on the next run: ${describe(error)}`);
        }
      }
      logger.info(
        `verification up to ${until}: ${summary.hit} hit, ${summary.falseAlarm} false alarm, ` +
          `${summary.missed} missed, ${summary.waiting} waiting for data, ${summary.failed} cells failed`,
      );
      return summary;
    },
  };
}

async function main(): Promise<void> {
  const { buildMonitor } = await import("./container.js");
  const built = buildMonitor();
  process.on("unhandledRejection", (reason) => built.logger.error(`unhandled rejection: ${describe(reason)}`));
  process.on("uncaughtException", (error) => built.logger.error(`uncaught exception: ${describe(error)}`));
  try {
    if (!built.config.enabled) {
      built.logger.info("MONITOR_ENABLED=false, nothing verified");
      return;
    }
    await createVerifier({ ...built, settings: built.config }).run();
  } catch (error) {
    built.logger.error(`verification run failed: ${describe(error)}`);
    process.exitCode = 1;
  } finally {
    await built.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
