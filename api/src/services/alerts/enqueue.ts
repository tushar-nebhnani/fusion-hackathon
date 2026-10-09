import type { PrismaClient } from "../../generated/prisma/client.js";
import type { AlertsConfig } from "./config.js";
import { firstTryAt } from "./policy.js";
import { alertEventSchema, dedupeKey, type AlertEvent, type Audience, type Channel } from "./types.js";
import { withTimeout } from "./withTimeout.js";

// A stuck database must not stall the caller for longer than this
const INSERT_TIMEOUT_MS = 2000;

export interface EnqueueDeps {
  prisma: PrismaClient;
  config: AlertsConfig;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
}

export type Enqueue = (event: AlertEvent) => Promise<boolean>;

// Each event becomes one email per audience
const PRIMARY: readonly { audience: Audience; channel: Channel }[] = [
  { audience: "owner", channel: "email" },
  { audience: "bank", channel: "email" },
];

export function outboxRows(event: AlertEvent, now: Date, config: AlertsConfig) {
  return PRIMARY.map(({ audience, channel }) => ({
    dedupeKey: dedupeKey(event),
    businessId: event.businessId,
    audience,
    channel,
    hazard: event.hazard,
    severity: event.severity,
    payload: event,
    nextTryAt: firstTryAt({ audience, severity: event.severity }, now, config),
    createdAt: now,
  }));
}

// The one function other modules call. It does a single INSERT and never
// rejects: on any problem it logs and resolves to false, so a broken alert
// system cannot stall or crash its caller. A repeated event is not an error;
// the unique dedupe key drops it.
export function createEnqueue(deps: EnqueueDeps): Enqueue {
  const { prisma, config } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  return async (event) => {
    try {
      if (!config.enabled) return false;
      const parsed = alertEventSchema.safeParse(event);
      if (!parsed.success) {
        logger.warn("alerts: event rejected,", parsed.error.issues[0]?.message ?? "invalid event");
        return false;
      }
      await withTimeout(
        prisma.alertOutbox.createMany({
          data: outboxRows(parsed.data, now(), config),
          skipDuplicates: true,
        }),
        INSERT_TIMEOUT_MS,
        "alert enqueue",
      );
      return true;
    } catch (error) {
      logger.error("alerts: enqueue failed,", error instanceof Error ? error.message : error);
      return false;
    }
  };
}
