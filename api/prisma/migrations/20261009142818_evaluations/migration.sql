-- CreateTable
CREATE TABLE "evaluations" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT NOT NULL,
    "requester_id" TEXT,
    "evaluator_version" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "reliable" BOOLEAN NOT NULL,
    "finance_profile_id" INTEGER,
    "climate_ref" TEXT,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evaluations_business_id_created_at_idx" ON "evaluations"("business_id", "created_at");
