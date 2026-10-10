import "dotenv/config";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Each audit event carries the hash of the one before it and a hash of its
// own fields chained onto that. Changing, removing or inserting a row breaks
// every hash after it. With AUDIT_HMAC_KEY set the hashes are HMACs under a
// key the database never sees, so someone who can write to Postgres still
// cannot rebuild a valid chain. Without the key they are plain SHA-256, which
// catches a partial edit but not a rewrite of the whole chain.

export interface ChainedFields {
  occurredAt: Date;
  requestId: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  status: number;
  reason: string | null;
}

export interface ChainedRow extends ChainedFields {
  id: number;
  prevHash: string | null;
  hash: string | null;
}

// The hash of the first event in a chain points back to this
export const GENESIS = "genesis";

const MIN_KEY_CHARS = 32;

// Read apart from config/env.ts: a bad value falls back to no key and never
// stops the API
export function loadAuditKey(source: NodeJS.ProcessEnv = process.env): string | null {
  const key = (source.AUDIT_HMAC_KEY ?? "").trim();
  return key.length >= MIN_KEY_CHARS ? key : null;
}

// Field order is fixed; JSON keeps nulls and strings apart unambiguously
function canonical(prevHash: string, fields: ChainedFields): string {
  return JSON.stringify([
    prevHash,
    fields.occurredAt.toISOString(),
    fields.requestId,
    fields.actorId,
    fields.actorRole,
    fields.action,
    fields.targetType,
    fields.targetId,
    fields.outcome,
    fields.status,
    fields.reason,
  ]);
}

export function chainHash(key: string | null, prevHash: string, fields: ChainedFields): string {
  const text = canonical(prevHash, fields);
  return (key ? createHmac("sha256", key) : createHash("sha256")).update(text).digest("hex");
}

// A tampered value need not be hex at all, so the decoded lengths are compared too
function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return a.length === b.length && left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export type ChainBreak = { id: number; reason: "unhashed" | "wrong_link" | "wrong_hash" };

// Checks rows in id order, carrying the last hash between batches. Rows
// written before the chain existed (no hash) are allowed only before the
// first hashed one.
export function createChainVerifier(key: string | null) {
  let last: string | null = null;
  let checked = 0;
  return {
    check(rows: readonly ChainedRow[]): ChainBreak | null {
      for (const row of rows) {
        if (row.hash === null) {
          if (last !== null) return { id: row.id, reason: "unhashed" };
          continue;
        }
        const expectedPrev = last ?? GENESIS;
        if (row.prevHash !== expectedPrev) return { id: row.id, reason: "wrong_link" };
        if (!sameHex(row.hash, chainHash(key, expectedPrev, row))) return { id: row.id, reason: "wrong_hash" };
        last = row.hash;
        checked += 1;
      }
      return null;
    },
    get checked() {
      return checked;
    },
  };
}
