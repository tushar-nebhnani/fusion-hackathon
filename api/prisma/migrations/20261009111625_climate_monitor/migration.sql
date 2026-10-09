-- CreateEnum
CREATE TYPE "MonitorLevel" AS ENUM ('NORMAL', 'WATCH', 'WARNING', 'SEVERE');

-- CreateEnum
CREATE TYPE "DisasterEventStatus" AS ENUM ('pending', 'hit', 'false_alarm', 'missed');

-- CreateTable
CREATE TABLE "monitored_cells" (
    "cell_id" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "level" "MonitorLevel" NOT NULL DEFAULT 'NORMAL',
    "calm_runs" INTEGER NOT NULL DEFAULT 0,
    "next_check_at" TIMESTAMPTZ NOT NULL,
    "last_checked_at" TIMESTAMPTZ,
    "last_snapshot" JSONB,
    "last_agent_review_at" TIMESTAMPTZ,
    "locked_by" TEXT,
    "lock_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "monitored_cells_pkey" PRIMARY KEY ("cell_id")
);

-- CreateTable
CREATE TABLE "disaster_events" (
    "event_id" SERIAL NOT NULL,
    "cell_id" TEXT NOT NULL,
    "hazard" TEXT NOT NULL,
    "level" "MonitorLevel" NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "forecast_values" JSONB NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" "DisasterEventStatus" NOT NULL DEFAULT 'pending',
    "observed_values" JSONB,
    "source_run_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ,

    CONSTRAINT "disaster_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "monitored_cells_active_next_check_at_idx" ON "monitored_cells"("active", "next_check_at");

-- CreateIndex
CREATE INDEX "disaster_events_status_window_end_idx" ON "disaster_events"("status", "window_end");

-- CreateIndex
CREATE INDEX "disaster_events_cell_id_hazard_window_start_idx" ON "disaster_events"("cell_id", "hazard", "window_start");
