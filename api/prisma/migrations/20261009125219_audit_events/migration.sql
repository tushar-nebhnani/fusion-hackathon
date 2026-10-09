-- CreateTable
CREATE TABLE "audit_events" (
    "id" SERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "outcome" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "reason" TEXT,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_occurred_at_idx" ON "audit_events"("target_type", "target_id", "occurred_at");

-- Append only: the application can add events but not change or remove them
CREATE FUNCTION "audit_events_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_change"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"();
