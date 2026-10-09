import type { RequestHandler } from "express";
import { z } from "zod";
import { BadRequestError } from "../errors/app-error.js";
import { buildFakeAlert, fakeAlertOptionsSchema } from "../services/advisor/dev/fakeAlert.js";
import type { Advisor } from "../services/advisor/index.js";
import { damageSchema } from "../services/advisor/types.js";

const id = z.string().min(1).max(64);

const chatBody = z.object({
  businessId: id,
  loanId: id.optional(),
  conversationId: z.uuid().optional(),
  message: z.string().trim().min(1).max(2000),
});

const damageBody = damageSchema.extend({
  loanId: id,
  message: z.string().trim().min(1).max(2000).optional(),
});

const decisionBody = z.object({
  decision: z.enum(["accept", "reject"]),
  note: z.string().max(1000).optional(),
  decidedBy: z.string().min(1).max(100).optional(),
});

const noteBody = z.object({ note: z.string().max(1000).optional() });

const verifyBody = z.object({ alertId: z.string().min(1).max(100), label: z.enum(["hit", "miss"]) });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BadRequestError(`Invalid ${issue?.path.join(".") || what}: ${issue?.message ?? ""}`);
  }
  return result.data;
}

const param = (value: unknown) => parse(id, value, "path parameter");

export function advisorController(advisor: Advisor) {
  const chat: RequestHandler = async (req, res) => {
    res.json(await advisor.handleChat(parse(chatBody, req.body, "body")));
  };

  const damageReport: RequestHandler = async (req, res) => {
    res.json(await advisor.handleDamageReport(parse(damageBody, req.body, "body")));
  };

  const decide: RequestHandler = async (req, res) => {
    const proposalId = parse(z.uuid(), req.params.id, "proposal id");
    res.json(await advisor.decideProposal(proposalId, parse(decisionBody, req.body, "body")));
  };

  const conversations: RequestHandler = async (req, res) => {
    res.json(await advisor.getConversations(param(req.params.businessId)));
  };

  const loanState: RequestHandler = async (req, res) => {
    res.json(await advisor.getLoanState(param(req.params.loanId)));
  };

  // Bank actions that move a loan through README §4's state machine
  const disburse: RequestHandler = async (req, res) => {
    const { note } = parse(noteBody, req.body, "body");
    res.json(await advisor.markDisbursed(param(req.params.loanId), note));
  };

  const closeRecovery: RequestHandler = async (req, res) => {
    const { note } = parse(noteBody, req.body, "body");
    res.json(await advisor.closeRecovery(param(req.params.loanId), note));
  };

  const businesses: RequestHandler = (_req, res) => {
    res.json({ businesses: advisor.listBusinesses() });
  };

  // ── Dev only: mounted when ADVISOR_ENABLE_DEV_ROUTES is on ────────────────

  const fakeAlert: RequestHandler = async (req, res) => {
    const event = buildFakeAlert(parse(fakeAlertOptionsSchema, req.body, "body"));
    res.json({ event, ...(await advisor.handleAlert(event)) });
  };

  const verifyAlert: RequestHandler = async (req, res) => {
    const { alertId, label } = parse(verifyBody, req.body, "body");
    res.json(await advisor.handleVerification(alertId, label));
  };

  const sweepAlerts: RequestHandler = async (_req, res) => {
    res.json({ movedToActive: await advisor.sweepAlerts() });
  };

  return {
    chat,
    damageReport,
    decide,
    conversations,
    loanState,
    disburse,
    closeRecovery,
    businesses,
    fakeAlert,
    verifyAlert,
    sweepAlerts,
  };
}
