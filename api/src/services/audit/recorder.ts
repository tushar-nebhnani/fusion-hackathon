import type { PrismaClient } from "../../generated/prisma/client.js";

export type AuditOutcome = "success" | "denied" | "failure";

// Who did what to which record, and how it ended. Never a request body, a
// token or a financial value.
export interface AuditEvent {
  requestId: string;
  // Null when nobody was signed in
  actorId: string | null;
  actorRole: string | null;
  // Method and route pattern, e.g. "PUT /businesses/:id/locations"
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  status: number;
  // Error code of a request that did not succeed
  reason: string | null;
}

export interface AuditRecorder {
  // Never throws and never delays the response
  record(event: AuditEvent): void;
  // Resolves once every event recorded so far has been written
  idle(): Promise<void>;
}

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

// Writes to `audit_events`, which the database keeps append only
export function createPrismaAuditRecorder(
  prisma: PrismaClient,
  logger: Pick<Console, "error"> = console,
): AuditRecorder {
  const writing = new Set<Promise<void>>();

  return {
    record(event) {
      const task: Promise<void> = prisma.auditEvent
        .create({
          data: {
            requestId: event.requestId.slice(0, 64),
            actorId: clip(event.actorId, 64),
            actorRole: clip(event.actorRole, 16),
            action: event.action.slice(0, 200),
            targetType: clip(event.targetType, 32),
            targetId: clip(event.targetId, 128),
            outcome: event.outcome,
            status: event.status,
            reason: clip(event.reason, 64),
          },
        })
        .then(
          () => undefined,
          (error: unknown) => {
            // A lost event is worth knowing about, without the event's contents
            logger.error(
              `audit: event for request ${event.requestId} was not stored,`,
              error instanceof Error ? error.name : "unknown error",
            );
          },
        )
        .finally(() => writing.delete(task));
      writing.add(task);
    },

    async idle() {
      while (writing.size > 0) await Promise.all(writing);
    },
  };
}
