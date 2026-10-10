-- Hash chain over the audit trail (services/audit/chain.ts). Existing rows
-- keep null hashes; the chain starts at the first event written after this.
ALTER TABLE "audit_events" ADD COLUMN "prev_hash" TEXT;
ALTER TABLE "audit_events" ADD COLUMN "hash" TEXT;

-- Two events can never claim the same predecessor, so the chain cannot fork
CREATE UNIQUE INDEX "audit_events_prev_hash_key" ON "audit_events"("prev_hash");
