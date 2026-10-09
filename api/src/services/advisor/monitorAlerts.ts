import type { PrismaClient } from "../../generated/prisma/client.js";
import { alertEventSchema, type Severity } from "../alerts/types.js";
import { snapPoint } from "../climate/grid.js";
import type { BusinessDirectory } from "./directory.js";
import type { Advisor } from "./index.js";
import type { AdvisorAlertEvent } from "./types.js";

// Hands the monitor's alerts to the advisor, so a live loan moves to ALERT
// and its owner gets ranked actions (README §5 Mode 2).
//
// It reads the alert system's outbox, never the monitor: only an owner alert
// the worker actually sent counts, so the alert system's consent, opt-out and
// cooldown checks have already been applied. Each outbox row is advised on
// once; its advisor alert id is `outbox-<row id>`.

const SEVERITY: Record<Severity, AdvisorAlertEvent["severity"]> = {
  WATCH: "watch",
  WARNING: "warning",
  CRITICAL: "severe",
};
const BATCH = 20;
const HOUR_MS = 3_600_000;

export interface MonitorAlertBridgeDeps {
  prisma: Pick<PrismaClient, "alertOutbox" | "advisorAlertEvent">;
  advisor: Pick<Advisor, "handleAlert">;
  directory: BusinessDirectory;
  // Sent alerts older than this are not advised on: the window has passed
  lookbackHours?: number;
  now?: () => Date;
  logger?: Pick<Console, "error">;
}

export function createMonitorAlertBridge(deps: MonitorAlertBridgeDeps) {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const lookbackMs = (deps.lookbackHours ?? 48) * HOUR_MS;
  let running = false;

  async function advise(row: { id: number; businessId: string; payload: unknown }): Promise<boolean> {
    const parsed = alertEventSchema.safeParse(row.payload);
    if (!parsed.success) return false;
    const business = await deps.directory.getBusiness(row.businessId).catch(() => null);
    const loanIds =
      business?.loans.filter((loan) => loan.initialState === "ACTIVE").map((loan) => loan.loanId) ?? [];
    if (!business || loanIds.length === 0) return false;
    const event = parsed.data;
    await deps.advisor.handleAlert({
      alertId: `outbox-${row.id}`,
      cellId: snapPoint(business.lat, business.lon).forecast.id,
      hazard: event.hazard,
      severity: SEVERITY[event.severity],
      windowStart: `${event.windowStart}T00:00:00+05:30`,
      windowEnd: `${event.windowEnd}T23:59:59+05:30`,
      loanIds,
    });
    return true;
  }

  return {
    // Resolves to the number of alerts advised on. One poll at a time
    async poll(): Promise<number> {
      if (running) return 0;
      running = true;
      try {
        const rows = await deps.prisma.alertOutbox.findMany({
          where: {
            audience: "owner",
            status: "sent",
            createdAt: { gte: new Date(now().getTime() - lookbackMs) },
          },
          select: { id: true, businessId: true, payload: true },
          orderBy: { id: "asc" },
        });
        const done = new Set(
          (
            await deps.prisma.advisorAlertEvent.findMany({
              where: { id: { in: rows.map((row) => `outbox-${row.id}`) } },
              select: { id: true },
            })
          ).map((event) => event.id),
        );
        let advised = 0;
        // Alerts for a business without a live loan are skipped, not marked:
        // they are looked at again until they leave the lookback window
        for (const row of rows.filter((candidate) => !done.has(`outbox-${candidate.id}`))) {
          if (advised >= BATCH) break;
          try {
            if (await advise(row)) advised += 1;
          } catch (error) {
            // handleAlert stores the event first, so a failure is not retried
            logger.error(
              `advisor: alert outbox-${row.id} for ${row.businessId} failed,`,
              error instanceof Error ? error.message : error,
            );
          }
        }
        return advised;
      } finally {
        running = false;
      }
    },
  };
}
