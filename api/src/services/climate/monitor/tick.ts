import { randomUUID } from "node:crypto";
import { AppError } from "../../../errors/app-error.js";
import type { ClimateInspector } from "../profile.service.js";
import { noAgentReview, type AgentReviewer } from "./agentReview.js";
import { groupByCell } from "./cells.js";
import { checkCell } from "./checkCell.js";
import type { MonitorConfig } from "./config.js";
import type { AlertSink, Clock, RunLogger, WatchedLocationSource } from "./ports.js";
import type { MonitorRepo } from "./repo.js";
import type { CellState } from "./types.js";

const IST_OFFSET_MS = 5.5 * 3_600_000;

export interface MonitorDeps {
  config: MonitorConfig;
  climate: ClimateInspector;
  source: WatchedLocationSource;
  sink: AlertSink;
  logger: RunLogger;
  clock: Clock;
  repo: MonitorRepo;
  review?: AgentReviewer;
  // Identifies this process in cell leases
  instanceId?: string;
}

export interface TickSummary {
  runId: string;
  // Cells that were due
  due: number;
  checked: number;
  failed: number;
  // Due cells left for a later tick: held by another monitor, or not started
  deferred: number;
  suddenChanges: number;
  alerts: number;
}

export interface Monitor {
  instanceId: string;
  // One full pass over the due cells. Never rejects because of a single cell.
  tick(): Promise<TickSummary>;
  // No new cell is started; cells being checked are finished
  stop(): void;
  // Hands back every lease this instance still holds
  release(): Promise<void>;
}

// "mon-2026-10-09T15:45", in IST like every other timestamp shown to people
export const runIdAt = (at: Date) =>
  `mon-${new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16)}`;

// Failures are reported the way the climate unit reports them: its error
// code and pipeline step when it has them
function describe(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.code}${error.step ? ` at ${error.step}` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const { config, logger, clock, repo } = deps;
  const instanceId = deps.instanceId ?? `monitor-${randomUUID()}`;
  const review = deps.review ?? noAgentReview;
  const leaseMs = config.leaseSeconds * 1000;
  let stopping = false;

  async function tick(): Promise<TickSummary> {
    const runId = runIdAt(clock.now());
    const summary: TickSummary = {
      runId,
      due: 0,
      checked: 0,
      failed: 0,
      deferred: 0,
      suddenChanges: 0,
      alerts: 0,
    };
    if (!config.enabled || stopping) return summary;

    const groups = groupByCell(await deps.source.list());
    await repo.syncCells(groups, clock.now());
    const locationsOf = new Map(groups.map((group) => [group.cellId, group.locations]));

    const due = await repo.listDue(clock.now());
    summary.due = due.length;

    async function check(candidate: CellState): Promise<void> {
      if (stopping) {
        summary.deferred += 1;
        return;
      }
      const { cellId } = candidate;
      try {
        const cell = await repo.claim(cellId, instanceId, clock.now(), leaseMs);
        if (!cell) {
          // Another monitor holds it, or already checked it
          summary.deferred += 1;
          return;
        }
        const outcome = await checkCell(
          { ...deps, review, settings: config, instanceId },
          cell,
          locationsOf.get(cellId) ?? [],
          runId,
        );
        summary.checked += 1;
        summary.suddenChanges += outcome.sudden.length;
        summary.alerts += outcome.alerts;
        logger.info(
          `${cellId}: ${outcome.from} -> ${outcome.to}` +
            (outcome.sudden.length > 0
              ? `, sudden change (${outcome.sudden.map((f) => `${f.hazard} ${f.level}`).join(", ")}), ` +
                `${outcome.alerts} alerts`
              : `, calm runs ${outcome.calmRuns}`) +
            `, next check ${outcome.nextCheckAt.toISOString()}`,
        );
      } catch (error) {
        // One failing cell must not stop the tick. Its state is untouched
        // and it is still due, so the next tick tries again.
        summary.failed += 1;
        logger.warn(`${cellId}: check failed, state kept, retried next tick: ${describe(error)}`);
        try {
          await repo.release(cellId, instanceId);
        } catch (releaseError) {
          logger.error(`${cellId}: lease could not be released: ${describe(releaseError)}`);
        }
      }
    }

    // Cells checked before share a bounded pool
    const known = due.filter((cell) => cell.lastCheckedAt !== null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(config.concurrency, known.length) }, async () => {
        for (let cell = known[next++]; cell; cell = known[next++]) await check(cell);
      }),
    );

    // A cell's first check may screen 30 years of history, which uses most of
    // Open-Meteo's per-minute allowance, so these go one at a time. One that
    // is rate limited fails fast and is tried again on the next tick.
    for (const cell of due.filter((candidate) => candidate.lastCheckedAt === null)) {
      await check(cell);
    }

    logger.info(
      `${runId}: ${summary.checked} of ${summary.due} due cells checked, ${summary.failed} failed, ` +
        `${summary.deferred} deferred, ${summary.suddenChanges} sudden changes, ${summary.alerts} alerts`,
    );
    return summary;
  }

  return {
    instanceId,
    tick,
    stop() {
      stopping = true;
    },
    release: () => repo.releaseAll(instanceId),
  };
}
