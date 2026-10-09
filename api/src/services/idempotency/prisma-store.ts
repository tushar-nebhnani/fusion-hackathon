import type { PrismaClient } from "../../generated/prisma/client.js";
import type { IdempotencyStore } from "../../middleware/idempotency.js";

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "P2002";

// Postgres-backed store, so keys hold across restarts and API instances
export function createPrismaIdempotencyStore(
  prisma: PrismaClient,
): IdempotencyStore & { purgeExpired(now?: Date): Promise<number> } {
  return {
    async begin({ scope, key, fingerprint, now, lockUntil }) {
      try {
        await prisma.idempotencyKey.create({
          data: { scope, key, fingerprint, expiresAt: lockUntil },
        });
        return { kind: "started" };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      // The key exists. Take it over if it has expired, in one statement so
      // two retries cannot both win.
      const takeover = await prisma.idempotencyKey.updateMany({
        where: { scope, key, expiresAt: { lte: now } },
        data: {
          fingerprint,
          responseStatus: null,
          responseBody: null,
          createdAt: now,
          expiresAt: lockUntil,
        },
      });
      if (takeover.count === 1) return { kind: "started" };

      const row = await prisma.idempotencyKey.findUnique({
        where: { scope_key: { scope, key } },
      });
      // Released between the two statements; the client can simply retry
      if (!row) return { kind: "in_progress" };
      if (row.fingerprint !== fingerprint) return { kind: "mismatch" };
      if (row.responseStatus === null || row.responseBody === null) {
        return { kind: "in_progress" };
      }
      return { kind: "replay", status: row.responseStatus, body: row.responseBody };
    },

    async complete({ scope, key, status, body, expiresAt }) {
      await prisma.idempotencyKey.updateMany({
        where: { scope, key },
        data: { responseStatus: status, responseBody: body, expiresAt },
      });
    },

    async release(scope, key) {
      await prisma.idempotencyKey.deleteMany({ where: { scope, key } });
    },

    async purgeExpired(now = new Date()) {
      const { count } = await prisma.idempotencyKey.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      return count;
    },
  };
}
