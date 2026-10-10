import { describe, expect, it } from "vitest";
import { GENESIS, chainHash, createChainVerifier, loadAuditKey, type ChainedFields, type ChainedRow } from "./chain.js";

const KEY = "k".repeat(32);

const fields = (n: number): ChainedFields => ({
  occurredAt: new Date(Date.UTC(2026, 9, 10, 6, 0, n)),
  requestId: `req-${String(n)}`,
  actorId: "user-owner",
  actorRole: "owner",
  action: "PUT /businesses/:id/locations",
  targetType: "business",
  targetId: "b-1",
  outcome: "denied",
  status: 403,
  reason: "LOCKED_BY_LOAN",
});

// A valid chain of `count` rows, as the recorder writes it
function chain(count: number, key: string | null = KEY): ChainedRow[] {
  const rows: ChainedRow[] = [];
  let prev = GENESIS;
  for (let n = 1; n <= count; n += 1) {
    const hash = chainHash(key, prev, fields(n));
    rows.push({ id: n, ...fields(n), prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

const verify = (rows: ChainedRow[], key: string | null = KEY) => createChainVerifier(key).check(rows);

describe("audit hash chain", () => {
  it("accepts an untouched chain, also when checked in batches", () => {
    const rows = chain(5);
    const verifier = createChainVerifier(KEY);

    expect(verifier.check(rows.slice(0, 2))).toBeNull();
    expect(verifier.check(rows.slice(2))).toBeNull();
    expect(verifier.checked).toBe(5);
  });

  it("finds a changed field, a removed row and an inserted row", () => {
    const edited = chain(4).map((row) => (row.id === 2 ? { ...row, outcome: "success", status: 200 } : row));
    const removed = chain(4).filter((row) => row.id !== 2);
    const inserted = chain(4);
    inserted.splice(2, 0, { ...fields(9), id: 99, prevHash: inserted[1]?.hash ?? null, hash: "ab".repeat(32) });

    expect(verify(edited)).toEqual({ id: 2, reason: "wrong_hash" });
    expect(verify(removed)).toEqual({ id: 3, reason: "wrong_link" });
    expect(verify(inserted)).toEqual({ id: 99, reason: "wrong_hash" });
  });

  it("cannot be rebuilt without the key: a chain rewritten with plain SHA-256 fails", () => {
    const forged = chain(3, null);

    expect(verify(forged)).toEqual({ id: 1, reason: "wrong_hash" });
  });

  it("allows events from before the chain only at its start", () => {
    const legacy = { ...fields(0), id: 0, prevHash: null, hash: null };
    const after = { ...fields(9), id: 9, prevHash: null, hash: null };

    expect(verify([legacy, ...chain(2)])).toBeNull();
    expect(verify([...chain(2), after])).toEqual({ id: 9, reason: "unhashed" });
  });

  it("reports a hash that is not even hex instead of throwing", () => {
    const rows = chain(2).map((row) => (row.id === 2 ? { ...row, hash: "not-hex" } : row));

    expect(verify(rows)).toEqual({ id: 2, reason: "wrong_hash" });
  });

  it("uses the key only when it is long enough", () => {
    expect(loadAuditKey({ AUDIT_HMAC_KEY: KEY })).toBe(KEY);
    expect(loadAuditKey({ AUDIT_HMAC_KEY: "short" })).toBeNull();
    expect(loadAuditKey({})).toBeNull();
  });
});
