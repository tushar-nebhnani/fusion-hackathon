import type { RequestHandler, Response } from "express";
import { z } from "zod";
import { AppError, BadRequestError } from "../errors/app-error.js";
import { requireUser } from "../middleware/auth.js";
import { buildFakeAlert, fakeAlertOptionsSchema } from "../services/advisor/dev/fakeAlert.js";
import type { Advisor } from "../services/advisor/index.js";
import { HAZARDS, type AlertEvent, type Hazard, type Severity } from "../services/alerts/types.js";
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

// Throws when the signed-in user may not see the business. The input
// service's rule: owners see their own, the bank sees what was shared with it.
export type AdvisorAccess = (businessId: string, actor: { role: "owner" | "bank"; id: string }) => Promise<void>;

// The alert system's enqueue(); resolves to whether the event was queued
export type EnqueueAlert = (event: AlertEvent) => Promise<boolean>;

const SEVERITY: Record<"watch" | "warning" | "severe", Severity> = {
  watch: "WATCH",
  warning: "WARNING",
  severe: "CRITICAL",
};

// The advisor's hazards are free text; the alert templates know a fixed list
const alertHazard = (hazard: string): Hazard =>
  (HAZARDS as readonly string[]).includes(hazard) ? (hazard as Hazard) : "flood";

const istDate = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);

export function advisorController(advisor: Advisor, assertAccess: AdvisorAccess, enqueue?: EnqueueAlert) {
  const actorOf = (res: Response) => {
    const user = requireUser(res);
    return { role: user.role, id: user.id };
  };
  const checkLoan = async (res: Response, loanId: string) => {
    await assertAccess(await advisor.businessOfLoan(loanId), actorOf(res));
    return loanId;
  };

  const chat: RequestHandler = async (req, res) => {
    const input = parse(chatBody, req.body, "body");
    await assertAccess(input.businessId, actorOf(res));
    res.json(await advisor.handleChat(input));
  };

  const damageReport: RequestHandler = async (req, res) => {
    const input = parse(damageBody, req.body, "body");
    await checkLoan(res, input.loanId);
    res.json(await advisor.handleDamageReport(input));
  };

  const decide: RequestHandler = async (req, res) => {
    const proposalId = parse(z.uuid(), req.params.id, "proposal id");
    await assertAccess(await advisor.businessOfProposal(proposalId), actorOf(res));
    // The signed-in bank officer, never a name taken from the body
    const decidedBy = requireUser(res).email;
    res.json(await advisor.decideProposal(proposalId, { ...parse(decisionBody, req.body, "body"), decidedBy }));
  };

  const conversations: RequestHandler = async (req, res) => {
    const businessId = param(req.params.businessId);
    await assertAccess(businessId, actorOf(res));
    res.json(await advisor.getConversations(businessId));
  };

  const loanState: RequestHandler = async (req, res) => {
    res.json(await advisor.getLoanState(await checkLoan(res, param(req.params.loanId))));
  };

  // Bank actions that move a loan through README §4's state machine
  const disburse: RequestHandler = async (req, res) => {
    const { note } = parse(noteBody, req.body, "body");
    res.json(await advisor.markDisbursed(await checkLoan(res, param(req.params.loanId)), note));
  };

  const closeRecovery: RequestHandler = async (req, res) => {
    const { note } = parse(noteBody, req.body, "body");
    res.json(await advisor.closeRecovery(await checkLoan(res, param(req.params.loanId)), note));
  };

  // Only the businesses this user may see
  const businesses: RequestHandler = async (_req, res) => {
    const actor = actorOf(res);
    const all = await advisor.listBusinesses();
    const allowed = await Promise.all(
      all.map((business) =>
        assertAccess(business.id, actor).then(
          () => true,
          (error: unknown) => {
            if (error instanceof AppError && error.statusCode === 404) return false;
            throw error;
          },
        ),
      ),
    );
    res.json({ businesses: all.filter((_, i) => allowed[i]) });
  };

  // ── Dev only: mounted when ADVISOR_ENABLE_DEV_ROUTES is on, bank officers only ──

  const fakeAlert: RequestHandler = async (req, res) => {
    const event = buildFakeAlert(parse(fakeAlertOptionsSchema, req.body, "body"));
    for (const loanId of event.loanIds) await checkLoan(res, loanId);
    const result = await advisor.handleAlert(event);
    // Also into the alert outbox, the way the monitor would, so the alert
    // worker emails it. Consent, dedupe and cooldown still apply there.
    let emailsQueued = 0;
    if (enqueue) {
      const businesses = new Set<string>();
      for (const loanId of event.loanIds) {
        const businessId = await advisor.businessOfLoan(loanId).catch(() => null);
        if (businessId) businesses.add(businessId);
      }
      for (const businessId of businesses) {
        const queued = await enqueue({
          businessId,
          hazard: alertHazard(event.hazard),
          severity: SEVERITY[event.severity],
          windowStart: istDate(event.windowStart),
          windowEnd: istDate(event.windowEnd),
          evidence: `Test alert raised from the demo (${event.hazard}, ${event.severity})`,
          sourceRunId: event.alertId,
        });
        if (queued) emailsQueued += 1;
      }
    }
    res.json({ event, ...result, emailsQueued });
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
