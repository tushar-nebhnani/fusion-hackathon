-- CreateEnum
CREATE TYPE "Relevance" AS ENUM ('primary', 'secondary', 'dormant');

-- CreateEnum
CREATE TYPE "RelevanceMethod" AS ENUM ('static', 'agent_raised');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('low', 'med', 'high');

-- CreateEnum
CREATE TYPE "MetricKind" AS ENUM ('observed', 'forecast', 'projection');

-- CreateEnum
CREATE TYPE "ResponseStatus" AS ENUM ('fresh', 'stale', 'error');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('watch', 'warning', 'severe');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('open', 'escalated', 'closed');

-- CreateEnum
CREATE TYPE "CacheResult" AS ENUM ('complete_hit', 'partial_hit', 'miss');

-- CreateTable
CREATE TABLE "hazard_catalog" (
    "hazard" TEXT NOT NULL,
    "apis" JSONB NOT NULL,
    "screening_variables" JSONB NOT NULL,
    "current_variables" JSONB NOT NULL,
    "indicator_rule" JSONB NOT NULL,
    "primary_threshold" DOUBLE PRECISION NOT NULL,
    "dormant_threshold" DOUBLE PRECISION NOT NULL,
    "tripwire_variables" JSONB NOT NULL,

    CONSTRAINT "hazard_catalog_pkey" PRIMARY KEY ("hazard")
);

-- CreateTable
CREATE TABLE "grid_cells" (
    "id" TEXT NOT NULL,
    "resolution_deg" DOUBLE PRECISION NOT NULL,
    "lat_center" DOUBLE PRECISION NOT NULL,
    "lon_center" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "grid_cells_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "points" (
    "id" SERIAL NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "cell_historical" TEXT NOT NULL,
    "cell_climate" TEXT NOT NULL,
    "cell_flood" TEXT NOT NULL,
    "cell_forecast" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_static_features" (
    "point_id" INTEGER NOT NULL,
    "elevation_m" DOUBLE PRECISION,
    "relative_elevation_m" DOUBLE PRECISION,
    "flood_exposure_share" DOUBLE PRECISION,
    "source_version" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "point_static_features_pkey" PRIMARY KEY ("point_id")
);

-- CreateTable
CREATE TABLE "cell_hazard_relevance" (
    "cell_id" TEXT NOT NULL,
    "hazard" TEXT NOT NULL,
    "relevance" "Relevance" NOT NULL,
    "indicator_value" DOUBLE PRECISION,
    "indicators" JSONB NOT NULL,
    "method" "RelevanceMethod" NOT NULL DEFAULT 'static',
    "rationale" TEXT,
    "evidence_urls" JSONB,
    "confidence" "Confidence" NOT NULL,
    "decided_at" TIMESTAMPTZ NOT NULL,
    "review_after" TIMESTAMPTZ NOT NULL,
    "rule_version" TEXT NOT NULL,
    "agent_version" TEXT,

    CONSTRAINT "cell_hazard_relevance_pkey" PRIMARY KEY ("cell_id","hazard")
);

-- CreateTable
CREATE TABLE "climate_responses" (
    "id" SERIAL NOT NULL,
    "cell_id" TEXT NOT NULL,
    "api" TEXT NOT NULL,
    "variables_requested" JSONB NOT NULL,
    "params_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "fetched_at" TIMESTAMPTZ NOT NULL,
    "stale_after" TIMESTAMPTZ,
    "status" "ResponseStatus" NOT NULL DEFAULT 'fresh',

    CONSTRAINT "climate_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "climate_metrics" (
    "cell_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "variable" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "kind" "MetricKind" NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL,
    "response_id" INTEGER,

    CONSTRAINT "climate_metrics_pkey" PRIMARY KEY ("cell_id","date","variable","kind","issued_at")
);

-- CreateTable
CREATE TABLE "hazard_scores" (
    "id" SERIAL NOT NULL,
    "point_id" INTEGER NOT NULL,
    "hazard" TEXT NOT NULL,
    "relevance" "Relevance" NOT NULL,
    "structural" DOUBLE PRECISION,
    "historical" DOUBLE PRECISION NOT NULL,
    "forecast" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "computed_at" TIMESTAMPTZ NOT NULL,
    "model_version" TEXT NOT NULL,

    CONSTRAINT "hazard_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cell_events" (
    "id" SERIAL NOT NULL,
    "cell_id" TEXT NOT NULL,
    "hazard" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source_response_id" INTEGER,
    "status" "EventStatus" NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cell_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_log" (
    "id" SERIAL NOT NULL,
    "requester_id" TEXT,
    "point_id" INTEGER NOT NULL,
    "cache_result" "CacheResult" NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "points_cell_flood_idx" ON "points"("cell_flood");

-- CreateIndex
CREATE INDEX "points_cell_forecast_idx" ON "points"("cell_forecast");

-- CreateIndex
CREATE UNIQUE INDEX "points_lat_lon_key" ON "points"("lat", "lon");

-- CreateIndex
CREATE INDEX "climate_responses_cell_id_api_stale_after_idx" ON "climate_responses"("cell_id", "api", "stale_after");

-- CreateIndex
CREATE UNIQUE INDEX "climate_responses_cell_id_api_params_hash_key" ON "climate_responses"("cell_id", "api", "params_hash");

-- CreateIndex
CREATE INDEX "climate_metrics_cell_id_variable_date_idx" ON "climate_metrics"("cell_id", "variable", "date");

-- CreateIndex
CREATE INDEX "hazard_scores_point_id_computed_at_idx" ON "hazard_scores"("point_id", "computed_at");

-- CreateIndex
CREATE INDEX "cell_events_status_window_start_idx" ON "cell_events"("status", "window_start");

-- CreateIndex
CREATE INDEX "cell_events_cell_id_hazard_status_idx" ON "cell_events"("cell_id", "hazard", "status");

-- CreateIndex
CREATE INDEX "request_log_point_id_created_at_idx" ON "request_log"("point_id", "created_at");

-- AddForeignKey
ALTER TABLE "points" ADD CONSTRAINT "points_cell_historical_fkey" FOREIGN KEY ("cell_historical") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points" ADD CONSTRAINT "points_cell_climate_fkey" FOREIGN KEY ("cell_climate") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points" ADD CONSTRAINT "points_cell_flood_fkey" FOREIGN KEY ("cell_flood") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "points" ADD CONSTRAINT "points_cell_forecast_fkey" FOREIGN KEY ("cell_forecast") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_static_features" ADD CONSTRAINT "point_static_features_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cell_hazard_relevance" ADD CONSTRAINT "cell_hazard_relevance_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cell_hazard_relevance" ADD CONSTRAINT "cell_hazard_relevance_hazard_fkey" FOREIGN KEY ("hazard") REFERENCES "hazard_catalog"("hazard") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "climate_responses" ADD CONSTRAINT "climate_responses_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "climate_metrics" ADD CONSTRAINT "climate_metrics_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "climate_metrics" ADD CONSTRAINT "climate_metrics_response_id_fkey" FOREIGN KEY ("response_id") REFERENCES "climate_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hazard_scores" ADD CONSTRAINT "hazard_scores_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hazard_scores" ADD CONSTRAINT "hazard_scores_hazard_fkey" FOREIGN KEY ("hazard") REFERENCES "hazard_catalog"("hazard") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cell_events" ADD CONSTRAINT "cell_events_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "grid_cells"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cell_events" ADD CONSTRAINT "cell_events_hazard_fkey" FOREIGN KEY ("hazard") REFERENCES "hazard_catalog"("hazard") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cell_events" ADD CONSTRAINT "cell_events_source_response_id_fkey" FOREIGN KEY ("source_response_id") REFERENCES "climate_responses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_log" ADD CONSTRAINT "request_log_point_id_fkey" FOREIGN KEY ("point_id") REFERENCES "points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
