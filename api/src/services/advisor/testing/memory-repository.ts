import { randomUUID } from "node:crypto";
import type { LoanStateRecord } from "../state.js";
import type { AdvisorAlertEvent, BusinessFactView } from "../types.js";
import type {
  AdvisorRepository,
  ConversationRow,
  MessageRow,
  ProposalRow,
  ToolCallRow,
} from "../repository.js";

// In-process stand-in for the Prisma repository, for tests
export function createMemoryAdvisorRepository() {
  const conversations = new Map<string, ConversationRow>();
  const messages: MessageRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const facts = new Map<string, Map<string, BusinessFactView>>();
  const loans = new Map<string, LoanStateRecord>();
  const proposals = new Map<string, ProposalRow>();
  const alerts = new Map<string, AdvisorAlertEvent>();
  const copy = <T>(value: T): T => structuredClone(value);

  const repo: AdvisorRepository = {
    createConversation(row) {
      const created = { ...row, id: randomUUID(), createdAt: new Date() };
      conversations.set(created.id, created);
      return Promise.resolve(copy(created));
    },
    getConversation: (id) => Promise.resolve(copy(conversations.get(id) ?? null)),
    listConversations: (businessId) =>
      Promise.resolve([...conversations.values()].filter((c) => c.businessId === businessId).map(copy)),

    addMessage(row) {
      const created = { ...copy(row), id: messages.length + 1, createdAt: new Date() };
      messages.push(created);
      return Promise.resolve(copy(created));
    },
    listMessages: (conversationId) =>
      Promise.resolve(messages.filter((m) => m.conversationId === conversationId).map(copy)),

    addToolCall(row) {
      toolCalls.push(copy(row));
      return Promise.resolve();
    },
    listToolCalls: (conversationId) =>
      Promise.resolve(toolCalls.filter((c) => c.conversationId === conversationId).map(copy)),

    getFacts: (businessId) => Promise.resolve([...(facts.get(businessId)?.values() ?? [])].map(copy)),
    saveFact(businessId, key, value, source) {
      const fact = { key, value, source, updatedAt: new Date().toISOString() };
      const forBusiness = facts.get(businessId) ?? new Map<string, BusinessFactView>();
      forBusiness.set(key, fact);
      facts.set(businessId, forBusiness);
      return Promise.resolve(copy(fact));
    },

    getLoanState: (loanId) => Promise.resolve(copy(loans.get(loanId) ?? null)),
    saveLoanState(record) {
      loans.set(record.loanId, copy(record));
      return Promise.resolve();
    },
    listLoansInState: (state) =>
      Promise.resolve([...loans.values()].filter((l) => l.state === state).map(copy)),

    createProposal(row) {
      for (const existing of proposals.values()) {
        if (existing.loanId === row.loanId && existing.status === "pending_bank") {
          existing.status = "superseded";
        }
      }
      const created: ProposalRow = {
        ...copy(row),
        id: randomUUID(),
        status: "pending_bank",
        decidedBy: null,
        decidedAt: null,
        note: null,
        createdAt: new Date(),
      };
      proposals.set(created.id, created);
      return Promise.resolve(copy(created));
    },
    getProposal: (id) => Promise.resolve(copy(proposals.get(id) ?? null)),
    decideProposal(id, decision) {
      const row = proposals.get(id);
      if (!row || row.status !== "pending_bank") return Promise.resolve(null);
      Object.assign(row, {
        status: decision.status,
        decidedBy: decision.decidedBy,
        decidedAt: decision.at,
        note: decision.note,
      });
      return Promise.resolve(copy(row));
    },

    saveAlertEvent(event) {
      alerts.set(event.alertId, copy(event));
      return Promise.resolve();
    },
    getAlertEvent: (alertId) => Promise.resolve(copy(alerts.get(alertId) ?? null)),
  };

  return { repo, toolCalls, messages };
}
