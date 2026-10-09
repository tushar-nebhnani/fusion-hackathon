-- CreateEnum
CREATE TYPE "LoanStateName" AS ENUM ('PRE_LOAN', 'ACTIVE', 'ALERT', 'IMPACTED', 'RECOVERY');

-- CreateEnum
CREATE TYPE "AdvisorMode" AS ENUM ('preLoan', 'alert', 'recovery');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('owner_chat', 'form', 'bank');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('pending_bank', 'accepted', 'rejected', 'superseded');

-- CreateTable
CREATE TABLE "advisor_conversations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "loan_id" TEXT,
    "mode" "AdvisorMode" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_messages" (
    "id" SERIAL NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "structured_output" JSONB,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_tool_calls" (
    "id" SERIAL NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "call_id" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_facts" (
    "business_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" "FactSource" NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "business_facts_pkey" PRIMARY KEY ("business_id","key")
);

-- CreateTable
CREATE TABLE "loan_states" (
    "loan_id" TEXT NOT NULL,
    "state" "LoanStateName" NOT NULL,
    "history" JSONB NOT NULL DEFAULT '[]',
    "damage" JSONB,
    "alert_id" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "loan_states_pkey" PRIMARY KEY ("loan_id")
);

-- CreateTable
CREATE TABLE "repayment_proposals" (
    "id" TEXT NOT NULL,
    "loan_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "options" JSONB NOT NULL,
    "recommended_index" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'pending_bank',
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repayment_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advisor_alert_events" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advisor_alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "advisor_conversations_business_id_created_at_idx" ON "advisor_conversations"("business_id", "created_at");

-- CreateIndex
CREATE INDEX "advisor_messages_conversation_id_id_idx" ON "advisor_messages"("conversation_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "advisor_tool_calls_conversation_id_call_id_key" ON "advisor_tool_calls"("conversation_id", "call_id");

-- CreateIndex
CREATE INDEX "repayment_proposals_loan_id_status_idx" ON "repayment_proposals"("loan_id", "status");

-- AddForeignKey
ALTER TABLE "advisor_messages" ADD CONSTRAINT "advisor_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "advisor_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advisor_tool_calls" ADD CONSTRAINT "advisor_tool_calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "advisor_conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
