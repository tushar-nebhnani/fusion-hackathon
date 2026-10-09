-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user',
    "external_id" TEXT,
    "name" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "operations" JSONB NOT NULL,
    "contacts" JSONB NOT NULL,
    "consent" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_locations" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL,
    "position" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "address" TEXT NOT NULL,
    "pincode" TEXT,
    "premises" TEXT,
    "floor" TEXT,

    CONSTRAINT "business_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_suppliers" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "share" DOUBLE PRECISION NOT NULL,
    "critical" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "business_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_snapshots" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "as_of" DATE NOT NULL,
    "raw" JSONB NOT NULL,
    "derived" JSONB NOT NULL,
    "derivation_version" TEXT NOT NULL,
    "verified_by_bank" BOOLEAN NOT NULL DEFAULT false,
    "verified_by" TEXT,
    "verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loans" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "emi" DOUBLE PRECISION NOT NULL,
    "tenure_months" INTEGER NOT NULL,
    "interest_rate" DOUBLE PRECISION,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'applied',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weather_impact_profiles" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "category" TEXT,
    "conditions" JSONB,
    "overall_confidence" DOUBLE PRECISION,
    "model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "inputs_hash" TEXT NOT NULL,
    "raw_output" JSONB,
    "note" TEXT,
    "overridden_by" TEXT,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "weather_impact_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_trigger_jobs" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "input_trigger_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "input_request_log" (
    "id" SERIAL NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "business_id" TEXT,
    "actor_role" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "input_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_external_id_key" ON "businesses"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_locations_business_id_position_key" ON "business_locations"("business_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "business_suppliers_business_id_position_key" ON "business_suppliers"("business_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "financial_snapshots_business_id_version_key" ON "financial_snapshots"("business_id", "version");

-- CreateIndex
CREATE INDEX "loans_business_id_idx" ON "loans"("business_id");

-- CreateIndex
CREATE INDEX "loans_status_idx" ON "loans"("status");

-- CreateIndex
CREATE INDEX "weather_impact_profiles_inputs_hash_prompt_version_model_st_idx" ON "weather_impact_profiles"("inputs_hash", "prompt_version", "model", "status");

-- CreateIndex
CREATE UNIQUE INDEX "weather_impact_profiles_business_id_version_key" ON "weather_impact_profiles"("business_id", "version");

-- CreateIndex
CREATE INDEX "input_trigger_jobs_status_created_at_idx" ON "input_trigger_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "input_trigger_jobs_business_id_status_idx" ON "input_trigger_jobs"("business_id", "status");

-- CreateIndex
CREATE INDEX "input_request_log_created_at_idx" ON "input_request_log"("created_at");

-- AddForeignKey
ALTER TABLE "business_locations" ADD CONSTRAINT "business_locations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_suppliers" ADD CONSTRAINT "business_suppliers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_snapshots" ADD CONSTRAINT "financial_snapshots_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weather_impact_profiles" ADD CONSTRAINT "weather_impact_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "input_trigger_jobs" ADD CONSTRAINT "input_trigger_jobs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
