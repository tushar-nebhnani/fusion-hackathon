-- CreateEnum
CREATE TYPE "AlertAudience" AS ENUM ('owner', 'bank');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WATCH', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('pending', 'sending', 'sent', 'failed', 'dead', 'suppressed');

-- CreateTable
CREATE TABLE "alert_businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "sector" TEXT,

    CONSTRAINT "alert_businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_outbox" (
    "id" SERIAL NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "audience" "AlertAudience" NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "hazard" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_try_at" TIMESTAMPTZ NOT NULL,
    "claimed_by" TEXT,
    "lease_until" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_deliveries" (
    "id" SERIAL NOT NULL,
    "outbox_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "subject" TEXT,
    "body" TEXT,
    "sent_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "alert_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_contacts" (
    "id" SERIAL NOT NULL,
    "business_id" TEXT,
    "audience" "AlertAudience" NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "consent_at" TIMESTAMPTZ,
    "opted_out_at" TIMESTAMPTZ,

    CONSTRAINT "alert_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_outbox_status_next_try_at_idx" ON "alert_outbox"("status", "next_try_at");

-- CreateIndex
CREATE INDEX "alert_outbox_business_id_hazard_audience_channel_idx" ON "alert_outbox"("business_id", "hazard", "audience", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "alert_outbox_dedupe_key_audience_channel_key" ON "alert_outbox"("dedupe_key", "audience", "channel");

-- CreateIndex
CREATE INDEX "alert_deliveries_outbox_id_idx" ON "alert_deliveries"("outbox_id");

-- CreateIndex
CREATE INDEX "alert_deliveries_sent_at_idx" ON "alert_deliveries"("sent_at");

-- CreateIndex
CREATE INDEX "alert_contacts_audience_business_id_idx" ON "alert_contacts"("audience", "business_id");

-- AddForeignKey
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "alert_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
