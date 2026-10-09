import {
  Prisma,
  type DisasterEvent,
  type MonitoredCell,
  type PrismaClient,
} from "../../../generated/prisma/client.js";
import type { CellGroup } from "./cells.js";
import {
  snapshotSchema,
  type CellState,
  type DisasterEventStatus,
  type MonitorLevel,
  type NewDisasterEvent,
  type Snapshot,
} from "./types.js";

// All reads and writes of the monitor's two tables, through the same Prisma
// client as the climate unit's repository.

const toDate = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`);
const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

export interface CheckResult {
  level: MonitorLevel;
  calmRuns: number;
  nextCheckAt: Date;
  lastCheckedAt: Date;
  lastSnapshot: Snapshot;
  lastAgentReviewAt: Date | null;
}

export interface StoredEvent {
  eventId: number;
  cellId: string;
  hazard: string;
  level: MonitorLevel;
  windowStart: string;
  windowEnd: string;
  forecastValues: unknown;
  observedValues: unknown;
  evidence: string;
  status: DisasterEventStatus;
}

function toState(row: MonitoredCell): CellState {
  const snapshot = snapshotSchema.safeParse(row.lastSnapshot);
  return {
    cellId: row.cellId,
    lat: row.lat,
    lon: row.lon,
    active: row.active,
    level: row.level,
    calmRuns: row.calmRuns,
    nextCheckAt: row.nextCheckAt,
    lastCheckedAt: row.lastCheckedAt,
    lastSnapshot: snapshot.success ? snapshot.data : null,
    lastAgentReviewAt: row.lastAgentReviewAt,
    createdAt: row.createdAt,
  };
}

function toEvent(row: DisasterEvent): StoredEvent {
  return {
    eventId: row.eventId,
    cellId: row.cellId,
    hazard: row.hazard,
    level: row.level,
    windowStart: toIsoDate(row.windowStart),
    windowEnd: toIsoDate(row.windowEnd),
    forecastValues: row.forecastValues,
    observedValues: row.observedValues,
    evidence: row.evidence,
    status: row.status,
  };
}

const eventRow = (event: NewDisasterEvent, at: Date) => ({
  cellId: event.cellId,
  hazard: event.hazard,
  level: event.level,
  windowStart: toDate(event.windowStart),
  windowEnd: toDate(event.windowEnd),
  forecastValues: event.forecastValues as Prisma.InputJsonValue,
  evidence: event.evidence,
  sourceRunId: event.sourceRunId,
  createdAt: at,
});

export function createMonitorRepo(prisma: PrismaClient) {
  // No lease, or one whose holder stopped renewing it
  const unlocked = (at: Date): Prisma.MonitoredCellWhereInput => ({
    OR: [{ lockUntil: null }, { lockUntil: { lte: at } }],
  });

  return {
    // Brings the table in line with the watched locations. A new cell starts
    // at NORMAL and is due now; so does one that is watched again after a
    // gap, since its old level says nothing about today. A cell with no
    // location left is switched off, not deleted.
    async syncCells(groups: CellGroup[], at: Date): Promise<void> {
      const ids = groups.map((group) => group.cellId);
      await prisma.monitoredCell.createMany({
        data: groups.map((group) => ({
          cellId: group.cellId,
          lat: group.lat,
          lon: group.lon,
          nextCheckAt: at,
          createdAt: at,
        })),
        skipDuplicates: true,
      });
      await prisma.monitoredCell.updateMany({
        where: { cellId: { in: ids }, active: false },
        data: {
          active: true,
          level: "NORMAL",
          calmRuns: 0,
          nextCheckAt: at,
          lastSnapshot: Prisma.DbNull,
          lastAgentReviewAt: null,
        },
      });
      for (const group of groups) {
        await prisma.monitoredCell.updateMany({
          where: {
            cellId: group.cellId,
            OR: [{ lat: { not: group.lat } }, { lon: { not: group.lon } }],
          },
          data: { lat: group.lat, lon: group.lon },
        });
      }
      await prisma.monitoredCell.updateMany({
        where: { active: true, cellId: { notIn: ids } },
        data: { active: false },
      });
    },

    async listDue(at: Date): Promise<CellState[]> {
      const rows = await prisma.monitoredCell.findMany({
        where: { active: true, nextCheckAt: { lte: at }, ...unlocked(at) },
        orderBy: [{ nextCheckAt: "asc" }, { cellId: "asc" }],
      });
      return rows.map(toState);
    },

    // Takes the lease on one due cell. The UPDATE checks the conditions
    // again, so of two monitors that saw the same cell only one gets it.
    async claim(cellId: string, owner: string, at: Date, leaseMs: number): Promise<CellState | null> {
      const { count } = await prisma.monitoredCell.updateMany({
        where: { cellId, active: true, nextCheckAt: { lte: at }, ...unlocked(at) },
        data: { lockedBy: owner, lockUntil: new Date(at.getTime() + leaseMs) },
      });
      if (count !== 1) return null;
      const row = await prisma.monitoredCell.findUnique({ where: { cellId } });
      return row ? toState(row) : null;
    },

    // Stores the outcome of a check and its disaster events together, and
    // hands the lease back. Nothing is written if the lease was lost.
    async saveCheck(
      cellId: string,
      owner: string,
      result: CheckResult,
      events: NewDisasterEvent[],
    ): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.monitoredCell.updateMany({
          where: { cellId, lockedBy: owner },
          data: {
            level: result.level,
            calmRuns: result.calmRuns,
            nextCheckAt: result.nextCheckAt,
            lastCheckedAt: result.lastCheckedAt,
            lastSnapshot: result.lastSnapshot,
            lastAgentReviewAt: result.lastAgentReviewAt,
            lockedBy: null,
            lockUntil: null,
          },
        });
        if (count !== 1) throw new Error(`lease on cell ${cellId} was lost; check discarded`);
        if (events.length > 0) {
          await tx.disasterEvent.createMany({
            data: events.map((event) => eventRow(event, result.lastCheckedAt)),
          });
        }
      });
    },

    // Hands a cell back unchanged, so it is still due on the next tick
    async release(cellId: string, owner: string): Promise<void> {
      await prisma.monitoredCell.updateMany({
        where: { cellId, lockedBy: owner },
        data: { lockedBy: null, lockUntil: null },
      });
    },

    async releaseAll(owner: string): Promise<void> {
      await prisma.monitoredCell.updateMany({
        where: { lockedBy: owner },
        data: { lockedBy: null, lockUntil: null },
      });
    },

    async getCell(cellId: string): Promise<CellState | null> {
      const row = await prisma.monitoredCell.findUnique({ where: { cellId } });
      return row ? toState(row) : null;
    },

    // Every cell ever watched, switched-off ones included
    async listCells(): Promise<CellState[]> {
      const rows = await prisma.monitoredCell.findMany({ orderBy: { cellId: "asc" } });
      return rows.map(toState);
    },

    // --- disaster events ---

    // Events still to be labelled whose window ended on or before `until`
    async pendingEvents(until: string): Promise<StoredEvent[]> {
      const rows = await prisma.disasterEvent.findMany({
        where: { status: "pending", windowEnd: { lte: toDate(until) } },
        orderBy: { eventId: "asc" },
      });
      return rows.map(toEvent);
    },

    // Events of a cell, of any status, whose window touches [from, to]
    async eventsBetween(cellId: string, from: string, to: string): Promise<StoredEvent[]> {
      const rows = await prisma.disasterEvent.findMany({
        where: { cellId, windowEnd: { gte: toDate(from) }, windowStart: { lte: toDate(to) } },
        orderBy: { eventId: "asc" },
      });
      return rows.map(toEvent);
    },

    async listEvents(cellId?: string): Promise<StoredEvent[]> {
      const rows = await prisma.disasterEvent.findMany({
        where: cellId ? { cellId } : {},
        orderBy: { eventId: "asc" },
      });
      return rows.map(toEvent);
    },

    async labelEvent(
      eventId: number,
      status: "hit" | "false_alarm",
      observed: Record<string, unknown>,
      at: Date,
    ): Promise<void> {
      await prisma.disasterEvent.update({
        where: { eventId },
        data: { status, observedValues: observed as Prisma.InputJsonValue, verifiedAt: at },
      });
    },

    // An observed extreme that no event forecast
    async insertMissed(
      event: NewDisasterEvent,
      observed: Record<string, unknown>,
      at: Date,
    ): Promise<void> {
      await prisma.disasterEvent.create({
        data: {
          ...eventRow(event, at),
          status: "missed",
          observedValues: observed as Prisma.InputJsonValue,
          verifiedAt: at,
        },
      });
    },
  };
}

export type MonitorRepo = ReturnType<typeof createMonitorRepo>;
