import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { LoanStateRecord, TransitionRecord } from "./state.js";
import type { AdvisorAlertEvent, AdvisorMode, BusinessFactView, FactSource } from "./types.js";

export interface ConversationRow {
  id: string;
  businessId: string;
  loanId: string | null;
  mode: AdvisorMode;
  createdAt: Date;
}

export interface MessageRow {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  structuredOutput: unknown;
  citations: string[];
  createdAt: Date;
}

export interface ToolCallRow {
  conversationId: string;
  callId: string;
  tool: string;
  input: unknown;
  output: unknown;
  error: string | null;
  durationMs: number;
}

export type ProposalStatus = "pending_bank" | "accepted" | "rejected" | "superseded";

export interface ProposalRow {
  id: string;
  loanId: string;
  conversationId: string | null;
  options: unknown[];
  recommendedIndex: number;
  explanation: string;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  note: string | null;
  createdAt: Date;
}

export type NewProposal = Pick<
  ProposalRow,
  "loanId" | "conversationId" | "options" | "recommendedIndex" | "explanation"
>;

export interface ProposalDecision {
  status: "accepted" | "rejected";
  decidedBy: string;
  note: string | null;
  at: Date;
}

// Everything the advisor stores. Prisma in the app, memory in tests.
export interface AdvisorRepository {
  createConversation(row: Omit<ConversationRow, "id" | "createdAt">): Promise<ConversationRow>;
  getConversation(id: string): Promise<ConversationRow | null>;
  // The most recent `limit` conversations, oldest of them first
  listConversations(businessId: string, limit: number): Promise<ConversationRow[]>;
  addMessage(row: Omit<MessageRow, "id" | "createdAt">): Promise<MessageRow>;
  listMessages(conversationId: string): Promise<MessageRow[]>;
  // Messages of several conversations in one read, in order within each
  listMessagesOf(conversationIds: string[]): Promise<MessageRow[]>;
  addToolCall(row: ToolCallRow): Promise<void>;
  listToolCalls(conversationId: string): Promise<ToolCallRow[]>;
  listToolCallsOf(conversationIds: string[]): Promise<ToolCallRow[]>;

  getFacts(businessId: string): Promise<BusinessFactView[]>;
  saveFact(businessId: string, key: string, value: string, source: FactSource): Promise<BusinessFactView>;

  getLoanState(loanId: string): Promise<LoanStateRecord | null>;
  saveLoanState(record: LoanStateRecord): Promise<void>;
  listLoansInState(state: LoanStateRecord["state"]): Promise<LoanStateRecord[]>;

  // Marks any pending proposal for the loan superseded, then stores this one
  createProposal(row: NewProposal): Promise<ProposalRow>;
  getProposal(id: string): Promise<ProposalRow | null>;
  // Null when the proposal is not pending (already decided or superseded)
  decideProposal(id: string, decision: ProposalDecision): Promise<ProposalRow | null>;

  saveAlertEvent(event: AdvisorAlertEvent): Promise<void>;
  getAlertEvent(alertId: string): Promise<AdvisorAlertEvent | null>;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const nullableJson = (value: unknown) =>
  value === null || value === undefined ? Prisma.DbNull : json(value);

interface StoredMessage extends Omit<MessageRow, "role" | "citations"> {
  role: string;
  citations: unknown;
}

interface StoredLoan {
  loanId: string;
  state: LoanStateRecord["state"];
  history: unknown;
  damage: unknown;
  alertId: string | null;
}

const toMessage = (row: StoredMessage): MessageRow => ({
  ...row,
  role: row.role === "user" ? "user" : "assistant",
  citations: Array.isArray(row.citations) ? row.citations.map(String) : [],
});

const toLoan = (row: StoredLoan): LoanStateRecord => ({
  loanId: row.loanId,
  state: row.state,
  history: Array.isArray(row.history) ? (row.history as TransitionRecord[]) : [],
  damage: row.damage ? row.damage : null,
  alertId: row.alertId,
});

const toProposal = (row: Omit<ProposalRow, "options"> & { options: unknown }): ProposalRow => ({
  ...row,
  options: Array.isArray(row.options) ? row.options : [],
});

export function createPrismaAdvisorRepository(prisma: PrismaClient): AdvisorRepository {
  return {
    createConversation: (row) => prisma.advisorConversation.create({ data: row }),
    getConversation: (id) => prisma.advisorConversation.findUnique({ where: { id } }),
    async listConversations(businessId, limit) {
      const rows = await prisma.advisorConversation.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return rows.reverse();
    },

    async addMessage(row) {
      const created = await prisma.advisorMessage.create({
        data: { ...row, structuredOutput: nullableJson(row.structuredOutput), citations: json(row.citations) },
      });
      return toMessage(created);
    },
    async listMessages(conversationId) {
      const rows = await prisma.advisorMessage.findMany({ where: { conversationId }, orderBy: { id: "asc" } });
      return rows.map(toMessage);
    },

    async listMessagesOf(conversationIds) {
      const rows = await prisma.advisorMessage.findMany({
        where: { conversationId: { in: conversationIds } },
        orderBy: { id: "asc" },
      });
      return rows.map(toMessage);
    },

    async addToolCall(row) {
      await prisma.advisorToolCall.create({
        data: { ...row, input: json(row.input ?? {}), output: nullableJson(row.output) },
      });
    },
    listToolCalls: (conversationId) =>
      prisma.advisorToolCall.findMany({ where: { conversationId }, orderBy: { id: "asc" } }),
    listToolCallsOf: (conversationIds) =>
      prisma.advisorToolCall.findMany({
        where: { conversationId: { in: conversationIds } },
        orderBy: { id: "asc" },
      }),

    async getFacts(businessId) {
      const rows = await prisma.businessFact.findMany({ where: { businessId }, orderBy: { key: "asc" } });
      return rows.map((row) => ({
        key: row.key,
        value: row.value,
        source: row.source,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },
    async saveFact(businessId, key, value, source) {
      const row = await prisma.businessFact.upsert({
        where: { businessId_key: { businessId, key } },
        update: { value, source },
        create: { businessId, key, value, source },
      });
      return { key: row.key, value: row.value, source: row.source, updatedAt: row.updatedAt.toISOString() };
    },

    async getLoanState(loanId) {
      const row = await prisma.loanState.findUnique({ where: { loanId } });
      return row ? toLoan(row) : null;
    },
    async saveLoanState(record) {
      const data = {
        state: record.state,
        history: json(record.history),
        damage: nullableJson(record.damage),
        alertId: record.alertId,
      };
      await prisma.loanState.upsert({
        where: { loanId: record.loanId },
        update: data,
        create: { loanId: record.loanId, ...data },
      });
    },
    async listLoansInState(state) {
      const rows = await prisma.loanState.findMany({ where: { state } });
      return rows.map(toLoan);
    },

    async createProposal(row) {
      const [, created] = await prisma.$transaction([
        prisma.repaymentProposal.updateMany({
          where: { loanId: row.loanId, status: "pending_bank" },
          data: { status: "superseded" },
        }),
        prisma.repaymentProposal.create({ data: { ...row, options: json(row.options) } }),
      ]);
      return toProposal(created);
    },
    async getProposal(id) {
      const row = await prisma.repaymentProposal.findUnique({ where: { id } });
      return row ? toProposal(row) : null;
    },
    async decideProposal(id, decision) {
      // The status condition makes a second decision a no-op
      const updated = await prisma.repaymentProposal.updateMany({
        where: { id, status: "pending_bank" },
        data: {
          status: decision.status,
          decidedBy: decision.decidedBy,
          decidedAt: decision.at,
          note: decision.note,
        },
      });
      if (updated.count === 0) return null;
      const row = await prisma.repaymentProposal.findUnique({ where: { id } });
      return row ? toProposal(row) : null;
    },

    async saveAlertEvent(event) {
      await prisma.advisorAlertEvent.upsert({
        where: { id: event.alertId },
        update: { payload: json(event) },
        create: { id: event.alertId, payload: json(event) },
      });
    },
    async getAlertEvent(alertId) {
      const row = await prisma.advisorAlertEvent.findUnique({ where: { id: alertId } });
      return row ? (row.payload as unknown as AdvisorAlertEvent) : null;
    },
  };
}
