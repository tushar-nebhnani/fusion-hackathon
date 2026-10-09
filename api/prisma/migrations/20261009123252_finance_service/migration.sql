-- CreateTable
CREATE TABLE "finance_profiles" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "snapshot_version" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "baseline_score" INTEGER NOT NULL,
    "adjusted_score" INTEGER,
    "scorer_source" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,
    "profile" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_request_log" (
    "id" SERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "business_id" TEXT,
    "ok" BOOLEAN NOT NULL,
    "error_code" TEXT,
    "sensitivity_source" TEXT,
    "scorer_source" TEXT,
    "fallbacks" JSONB NOT NULL,
    "stage_ms" JSONB NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_profiles_business_id_created_at_idx" ON "finance_profiles"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "finance_request_log_created_at_idx" ON "finance_request_log"("created_at");

-- CreateIndex
CREATE INDEX "finance_request_log_business_id_created_at_idx" ON "finance_request_log"("business_id", "created_at");

-- AddForeignKey
ALTER TABLE "finance_profiles" ADD CONSTRAINT "finance_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
