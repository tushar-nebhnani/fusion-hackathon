-- CreateTable
CREATE TABLE "app_logs" (
    "id" BIGSERIAL NOT NULL,
    "time" TIMESTAMPTZ NOT NULL,
    "level" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "request_id" TEXT,
    "user_id" TEXT,
    "fields" JSONB,

    CONSTRAINT "app_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_logs_time_idx" ON "app_logs"("time");

-- CreateIndex
CREATE INDEX "app_logs_level_time_idx" ON "app_logs"("level", "time");

-- CreateIndex
CREATE INDEX "app_logs_request_id_idx" ON "app_logs"("request_id");
