import { BadRequestError, ConflictError, NotFoundError } from "../../errors/app-error.js";
import { runAgent, type AgentResult } from "./agent.js";
import {
  alertOutput,
  citationsOf,
  dismissivePhrases,
  preLoanOutput,
  raiseVerdict,
  recoveryOutput,
  textOf,
  verdictFloor,
  type AlertOutput,
  type PreLoanOutput,
  type RecoveryOutput,
} from "./checks.js";
import type { BusinessDirectory } from "./directory.js";
import type { LlmClient, LlmMessage } from "./llm/client.js";
import { PROMPT_VERSION, systemPrompt } from "./prompts/index.js";
import type { ConversationRow, ProposalRow } from "./repository.js";
import { modeFor, transition, type LoanStateRecord } from "./state.js";
import { createToolRunner, istLabel, istToday, type ToolDeps, type ToolResult } from "./tools/index.js";
import { getBusinessFacts } from "./tools/memory.js";
import type { ContactBook, DeliveryStatus } from "./tools/messaging.js";
import type { RepaymentResult } from "./tools/repayment.js";
import type { ScenarioResult } from "./tools/scenario.js";
import {
  advisorAlertEventSchema,
  damageSchema,
  hazardFromAlert,
  type AdvisorAlertEvent,
  type AdvisorMode,
  type BusinessRecord,
  type Damage,
  type LoanRecord,
} from "./types.js";

export interface AdvisorDeps extends ToolDeps {
  directory: BusinessDirectory;
  contacts: ContactBook;
  llm: LlmClient;
  maxIterations: number;
  // Owner steps per hazard group and severity, from the alert system's
  // guidelines.json. They are the floor for alert actions.
  ownerSteps: (hazardGroup: string, severity: "WATCH" | "WARNING" | "CRITICAL") => string[];
  now?: () => Date;
}

export interface ChatRequest {
  businessId: string;
  loanId?: string;
  conversationId?: string;
  message: string;
}

export interface ToolCallSummary {
  callId: string;
  tool: string;
  ok: boolean;
  error?: string;
}

export interface ProposalView {
  id: string;
  loanId: string;
  status: ProposalRow["status"];
  recommendedIndex: number;
  explanation: string;
  options: unknown[];
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface TurnResult {
  conversationId: string;
  mode: AdvisorMode;
  loanId: string | null;
  loanState: string | null;
  reply: string;
  structured: Record<string, unknown> | null;
  citations: string[];
  warnings: string[];
  toolCalls: ToolCallSummary[];
  proposal?: ProposalView;
}

type AlertActions = AlertOutput["actions"];

const SEVERITY = { watch: "WATCH", warning: "WARNING", severe: "CRITICAL" } as const;
const SMS_LIMIT = 160;
const HOUR_MS = 3_600_000;

const viewProposal = (row: ProposalRow): ProposalView => ({
  id: row.id,
  loanId: row.loanId,
  status: row.status,
  recommendedIndex: row.recommendedIndex,
  explanation: row.explanation,
  options: row.options,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  note: row.note,
});

const summarise = (calls: ToolResult[]): ToolCallSummary[] =>
  calls.map((call) => ({
    callId: call.callId,
    tool: call.tool,
    ok: !call.error,
    ...(call.error ? { error: call.error } : {}),
  }));

const hazardGroup = (hazard: string | null) =>
  hazard === "river_flood" || hazard === "flash_flood" ? "flood" : (hazard ?? "flood");

// Head and tail always fit; the middle (the top action) is cut at a word
// boundary when the whole would pass the limit
export function fitSms(head: string, middle: string, tail: string, limit = SMS_LIMIT): string {
  const whole = `${head} ${middle} ${tail}`;
  if (whole.length <= limit) return whole;
  const room = limit - head.length - tail.length - 3;
  if (room <= 0) return `${head} ${tail}`.slice(0, limit);
  const cut = middle.slice(0, room);
  const space = cut.lastIndexOf(" ");
  return `${head} ${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()}… ${tail}`;
}

// Built from tool names and errors only, so a failed turn shows no number
// the code did not produce
function fallbackReply(result: AgentResult<unknown>): string {
  const reason =
    result.status === "model_error"
      ? `the advisor model is unavailable (${result.error ?? "unknown error"})`
      : "I reached my step limit before finishing";
  const checked = result.calls.map((call) => `${call.tool}: ${call.error ? `unavailable (${call.error})` : "ok"}`);
  return [
    `I could not complete this answer: ${reason}.`,
    checked.length > 0 ? `What I checked so far: ${checked.join("; ")}.` : "",
    "Please try again in a moment, or contact your bank officer.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function createAdvisor(deps: AdvisorDeps) {
  const { repo, directory } = deps;
  const now = deps.now ?? (() => new Date());

  // ── Lookups ───────────────────────────────────────────────────────────────

  async function requireBusiness(businessId: string): Promise<BusinessRecord> {
    const business = await directory.getBusiness(businessId);
    if (!business) throw new NotFoundError(`Business ${businessId} not found`);
    return business;
  }

  async function requireLoan(loanId: string): Promise<{ business: BusinessRecord; loan: LoanRecord }> {
    const found = await directory.findLoan(loanId);
    if (!found) throw new NotFoundError(`Loan ${loanId} not found`);
    return found;
  }

  // A loan the advisor has not seen starts in its smes.json initial state
  async function loanState(loan: LoanRecord): Promise<LoanStateRecord> {
    const stored = await repo.getLoanState(loan.loanId);
    // The input service marked the loan active since the advisor last saw it
    if (stored?.state === "PRE_LOAN" && loan.initialState === "ACTIVE") {
      const disbursed = transition(stored, "disbursed", "loan marked active by the bank", now());
      await repo.saveLoanState(disbursed);
      return disbursed;
    }
    if (stored) return stored;
    const fresh: LoanStateRecord = {
      loanId: loan.loanId,
      state: loan.initialState,
      history: [],
      damage: null,
      alertId: null,
    };
    await repo.saveLoanState(fresh);
    return fresh;
  }

  // ── One agent turn ───────────────────────────────────────────────────────

  interface Turn {
    conversation: ConversationRow;
    business: BusinessRecord;
    loan: LoanRecord | null;
    state: LoanStateRecord | null;
    input: string;
    // Alert turns are started by an event, not by something the owner said
    storeInput: boolean;
    alertId?: string | null;
    // Runs after the agent, before the assistant message is stored
    finish?: (result: TurnResult, calls: ToolResult[]) => Promise<void>;
  }

  async function runTurn(turn: Turn): Promise<TurnResult> {
    const { conversation, business, loan } = turn;
    const mode = modeFor(turn.state?.state ?? null);
    const at = now();
    const messages = await repo.listMessages(conversation.id);
    const priorCalls = await repo.listToolCalls(conversation.id);
    if (turn.storeInput) {
      await repo.addMessage({
        conversationId: conversation.id,
        role: "user",
        content: turn.input,
        structuredOutput: null,
        citations: [],
      });
    }

    const facts = await getBusinessFacts(repo, business);
    const questionRoundsSoFar = messages.filter((m) => {
      const out = m.structuredOutput as { questions?: unknown[] } | null;
      return m.role === "assistant" && Array.isArray(out?.questions) && out.questions.length > 0;
    }).length;
    const alertId = turn.alertId ?? turn.state?.alertId ?? null;
    const context = {
      mode,
      promptVersion: PROMPT_VERSION,
      today: istToday(at),
      business: {
        id: business.id,
        name: business.name,
        ownerName: business.ownerName,
        sector: business.sector,
        description: business.description,
        city: business.city,
        state: business.state,
      },
      loan: loan
        ? {
            loanId: loan.loanId,
            state: turn.state?.state ?? null,
            principal: loan.principal,
            annualRatePct: loan.annualRatePct,
            tenureMonths: loan.tenureMonths,
            disbursedOn: loan.disbursedOn,
          }
        : null,
      generalQuestionsOnActiveLoan: turn.state?.state === "ACTIVE",
      questionRoundsSoFar,
      alertId,
      businessFacts: facts.facts.map(({ key, value, source }) => ({ key, value, source })),
    };
    const runner = createToolRunner(
      deps,
      { conversationId: conversation.id, business, loan, loanState: turn.state, alertId, now: at },
      priorCalls.length + 1,
    );
    const common = {
      llm: deps.llm,
      runner,
      system: systemPrompt(mode, context),
      history: messages.map((m): LlmMessage => ({ role: m.role, content: m.content })),
      input: turn.input,
      maxIterations: deps.maxIterations,
      priorCalls: priorCalls.map((c) => ({ callId: c.callId, output: c.output, error: c.error })),
      extraSources: [
        ...messages.filter((m) => m.role === "user").map((m) => m.content),
        facts.facts.map((f) => f.value),
      ],
    };

    const result: TurnResult = {
      conversationId: conversation.id,
      mode,
      loanId: loan?.loanId ?? null,
      loanState: turn.state?.state ?? null,
      reply: "",
      structured: null,
      citations: [],
      warnings: [],
      toolCalls: [],
    };
    let calls: ToolResult[];

    if (mode === "preLoan") {
      const run = await runAgent<PreLoanOutput>({
        ...common,
        mode,
        output: {
          schema: preLoanOutput,
          texts: textOf.preLoan,
          citations: citationsOf.preLoan,
          problems: (out, runCalls) => {
            const problems: string[] = [];
            if (out.questions.length > 2) problems.push("Ask at most 2 questions per turn.");
            const simulated = [...priorCalls, ...runCalls].some(
              (c) => c.tool === "simulateScenario" && !c.error,
            );
            if (out.assessment && out.assessment.risks.length > 0 && !simulated) {
              problems.push("Run simulateScenario for the material hazards before giving risks and a verdict.");
            }
            if (out.assessment?.risks.some((risk) => risk.citations.length === 0)) {
              problems.push("Every risk needs at least one citation.");
            }
            return problems;
          },
        },
      });
      calls = run.calls;
      if (run.status === "answered") {
        const { assessment } = run.output;
        const scenarios = run.calls
          .filter((c) => c.tool === "simulateScenario" && c.output)
          .map((c) => c.output as ScenarioResult);
        // The model may be stricter than the numbers, never more lenient
        const verdict = assessment ? raiseVerdict(assessment.verdict, verdictFloor(scenarios)) : null;
        result.reply = run.output.reply;
        result.structured = {
          questions: run.output.questions.slice(0, 2),
          verdict,
          ...(assessment
            ? {
                summary: assessment.summary,
                risks: assessment.risks,
                loanStructureSuggestions: assessment.loanStructureSuggestions,
                bankSummary: assessment.bankSummary,
                ...(verdict !== assessment.verdict
                  ? {
                      verdictRaisedFrom: assessment.verdict,
                      verdictRaisedBecause: "a simulated DSCR is below the threshold for that verdict",
                    }
                  : {}),
              }
            : {}),
        };
        result.citations = run.citations;
        result.warnings = run.warnings;
      } else {
        result.reply = fallbackReply(run);
        result.warnings = [run.status];
      }
    } else if (mode === "alert") {
      const event = alertId ? await repo.getAlertEvent(alertId) : null;
      const firstTurn = !turn.storeInput;
      const run = await runAgent<AlertOutput>({
        ...common,
        mode,
        output: {
          schema: alertOutput,
          texts: textOf.alert,
          citations: citationsOf.alert,
          problems: (out) => {
            const problems: string[] = [];
            if (firstTurn && (out.actions.length < 3 || out.actions.length > 5)) {
              problems.push("Give 3 to 5 actions ranked by urgency.");
            }
            if (out.actions.some((a) => a.citations.length === 0)) {
              problems.push("Every action needs at least one citation.");
            }
            const dismissive = dismissivePhrases(textOf.alert(out));
            if (dismissive.length > 0) {
              problems.push(
                `Never suggest the alert can be ignored (found: ${dismissive.join(", ")}). You may only add urgency.`,
              );
            }
            return problems;
          },
        },
      });
      calls = run.calls;
      const fallbackDeadline = event
        ? new Date(Math.max(at.getTime(), Date.parse(event.windowStart) - 6 * HOUR_MS)).toISOString()
        : at.toISOString();
      const deadline = (value: string) =>
        !Number.isNaN(Date.parse(value)) && (!event || Date.parse(value) <= Date.parse(event.windowEnd))
          ? new Date(value).toISOString()
          : fallbackDeadline;

      let actions: AlertActions = [];
      let bankSummary = "";
      if (run.status === "answered") {
        // An answer that still dismisses the alert is not shown (README §1 rule 5)
        const dismissive = dismissivePhrases(textOf.alert(run.output)).length > 0;
        if (!dismissive) {
          actions = [...run.output.actions]
            .sort((a, b) => a.rank - b.rank)
            .slice(0, 5)
            .map((a, i) => ({ ...a, rank: i + 1, deadline: deadline(a.deadline) }));
          bankSummary = run.output.bankSummary;
        }
        result.reply = dismissive
          ? "A climate alert is active for your business. Please follow the actions below and watch for official advice."
          : run.output.reply;
        result.citations = run.citations;
        result.warnings = [...run.warnings, ...(dismissive ? ["dismissive answer replaced"] : [])];
      } else {
        result.reply = fallbackReply(run);
        result.warnings = [run.status];
      }

      // On the first turn the alert system's own steps fill the list up to
      // three. Actions are only ever added, never removed.
      if (firstTurn && event && actions.length < 3) {
        const severity = SEVERITY[event.severity];
        const alertCall = await runner.run("getAlertContext", { alertId: event.alertId }, "code");
        calls = [...calls, alertCall];
        for (const step of deps.ownerSteps(hazardGroup(hazardFromAlert(event.hazard)), severity)) {
          if (actions.length >= 3) break;
          if (actions.some((a) => a.action === step)) continue;
          actions.push({
            rank: actions.length + 1,
            action: step,
            deadline: fallbackDeadline,
            why: `Standard ${severity} guidance for this hazard from the alert system.`,
            citations: [alertCall.callId],
          });
        }
      }
      result.structured = { actions, bankSummary };
    } else {
      const run = await runAgent<RecoveryOutput>({
        ...common,
        mode,
        output: {
          schema: recoveryOutput,
          texts: textOf.recovery,
          citations: citationsOf.recovery,
          problems: (out, runCalls) => {
            const problems: string[] = [];
            if (out.questions.length > 2) problems.push("Ask at most 2 questions per turn.");
            if (out.recommendation) {
              const latest = [...runCalls].reverse().find((c) => c.tool === "generateRepaymentOptions" && c.output);
              const count = (latest?.output as RepaymentResult | undefined)?.options.length ?? 0;
              if (!latest) problems.push("Call generateRepaymentOptions before recommending an option.");
              else if (out.recommendation.optionIndex >= count) {
                problems.push(`optionIndex must be between 0 and ${count - 1}.`);
              }
            }
            return problems;
          },
        },
      });
      calls = run.calls;
      if (run.status === "answered") {
        result.reply = run.output.reply;
        result.citations = run.citations;
        result.warnings = run.warnings;
        const optionsCall = [...run.calls].reverse().find((c) => c.tool === "generateRepaymentOptions" && c.output);
        const generated = optionsCall?.output as RepaymentResult | undefined;
        let recommendedIndex = run.output.recommendation?.optionIndex ?? null;
        if (generated && (recommendedIndex === null || recommendedIndex >= generated.options.length)) {
          // The model did not pick a valid option: take the smallest cash shortfall
          recommendedIndex = generated.options.reduce(
            (best, option, i, all) => (option.cashShortfall < (all[best]?.cashShortfall ?? Infinity) ? i : best),
            0,
          );
        }
        result.structured = {
          questions: run.output.questions.slice(0, 2),
          recommendation:
            recommendedIndex === null
              ? null
              : { optionIndex: recommendedIndex, why: run.output.recommendation?.why ?? "" },
          optionsCallId: optionsCall?.callId ?? null,
        };
        // README §5 Mode 3 step 5: a proposal the bank accepts or rejects
        if (generated && loan && turn.state?.state === "IMPACTED" && recommendedIndex !== null) {
          const proposal = await repo.createProposal({
            loanId: loan.loanId,
            conversationId: conversation.id,
            options: generated.options,
            recommendedIndex,
            explanation: run.output.reply,
          });
          result.proposal = viewProposal(proposal);
        }
      } else {
        result.reply = fallbackReply(run);
        result.warnings = [run.status];
      }
    }

    if (turn.finish) await turn.finish(result, calls);
    result.toolCalls = summarise(calls);
    await repo.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: result.reply,
      structuredOutput: {
        ...result.structured,
        ...(result.proposal ? { proposalId: result.proposal.id } : {}),
        warnings: result.warnings,
        model: deps.llm.version,
      },
      citations: result.citations,
    });
    return result;
  }

  // ── Mode entry points ────────────────────────────────────────────────────

  async function handleChat(request: ChatRequest): Promise<TurnResult> {
    const business = await requireBusiness(request.businessId);
    let conversation: ConversationRow | null = null;
    if (request.conversationId) {
      conversation = await repo.getConversation(request.conversationId);
      if (!conversation || conversation.businessId !== business.id) {
        throw new NotFoundError(`Conversation ${request.conversationId} not found for ${business.id}`);
      }
    }
    const loanId = request.loanId ?? conversation?.loanId ?? null;
    let loan: LoanRecord | null = null;
    if (loanId) {
      const found = await requireLoan(loanId);
      if (found.business.id !== business.id) {
        throw new BadRequestError(`Loan ${loanId} does not belong to ${business.id}`);
      }
      loan = found.loan;
    }
    const state = loan ? await loanState(loan) : null;
    conversation ??= await repo.createConversation({
      businessId: business.id,
      loanId: loan?.loanId ?? null,
      mode: modeFor(state?.state ?? null),
    });
    return runTurn({ conversation, business, loan, state, input: request.message, storeInput: true });
  }

  async function handleAlert(input: AdvisorAlertEvent) {
    const parsed = advisorAlertEventSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(`Invalid alert event: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`);
    }
    const event = parsed.data;
    await repo.saveAlertEvent(event);
    const hazard = hazardFromAlert(event.hazard);
    const label = (hazard ?? event.hazard).replace(/_/g, " ");
    const results: Record<string, unknown>[] = [];

    for (const loanId of event.loanIds) {
      const found = await directory.findLoan(loanId);
      if (!found) {
        results.push({ loanId, status: "skipped", reason: "unknown loan" });
        continue;
      }
      const { business, loan } = found;
      let state = await loanState(loan);
      if (state.state === "PRE_LOAN") {
        results.push({ loanId, status: "skipped", reason: "loan not disbursed" });
        continue;
      }
      if (state.state === "ACTIVE" || state.state === "ALERT") {
        state = transition(state, "alert", `${event.hazard} ${event.severity} alert ${event.alertId}`, now(), {
          alertId: event.alertId,
        });
        await repo.saveLoanState(state);
      }
      const conversation = await repo.createConversation({ businessId: business.id, loanId, mode: "alert" });
      const contacts = await deps.contacts.forBusiness(business);
      // IMPACTED and RECOVERY loans keep their state but still get the advice
      const adviceState: LoanStateRecord = { ...state, state: "ALERT", alertId: event.alertId };

      const turn = await runTurn({
        conversation,
        business,
        loan,
        state: adviceState,
        input: `A ${event.severity} ${event.hazard} alert (id ${event.alertId}) was raised for this business. Give the owner ranked actions before the window.`,
        storeInput: false,
        alertId: event.alertId,
        // README §5 Mode 2 step 3: SMS + email to the owner, a copy to the bank
        finish: async (result, calls) => {
          const { actions, bankSummary } = result.structured as { actions: AlertActions; bankSummary: string };
          const smsText = fitSms(
            `ClimaCredit ${event.severity.toUpperCase()}: ${label} from ${istLabel(event.windowStart)}.`,
            `${(actions[0]?.action ?? "Protect stock and records").replace(/\.$/, "")}.`,
            "Reply or open chat.",
          );
          const emailBody = [
            `Dear ${business.ownerName},`,
            "",
            result.reply,
            "",
            ...actions.map((a) => `${a.rank}. ${a.action}\n   By: ${istLabel(a.deadline)}\n   Why: ${a.why}`),
            "",
            "Reply to this email or open the ClimaCredit chat to ask a follow-up question.",
          ].join("\n");
          const bankBody = [
            `${business.name} (${business.id}), loan ${loanId}`,
            `${label} ${event.severity}: ${istLabel(event.windowStart)} to ${istLabel(event.windowEnd)}`,
            "",
            bankSummary || "Advisor summary unavailable; the owner's actions are below.",
            "",
            ...actions.map((a) => `${a.rank}. ${a.action}`),
          ].join("\n");

          const sender = createToolRunner(
            deps,
            { conversationId: conversation.id, business, loan, loanState: adviceState, alertId: event.alertId, now: now() },
            (await repo.listToolCalls(conversation.id)).length + 1,
          );
          const send = async (channel: "sms" | "email", to: string | null, body: string, subject?: string) => {
            const sent = await sender.run("sendMessage", { channel, to, body, subject }, "code");
            calls.push(sent);
            return (sent.output as DeliveryStatus | undefined) ?? {
              channel,
              to: null,
              status: "failed" as const,
              provider: null,
              error: sent.error,
            };
          };
          const deliveries: DeliveryStatus[] = [
            await send("sms", contacts.ownerPhone, smsText),
            await send("email", contacts.ownerEmail, emailBody, `[ClimaCredit] ${label} ${event.severity}: actions for ${business.name}`),
          ];
          for (const to of contacts.bankEmails) {
            deliveries.push(await send("email", to, bankBody, `[ClimaCredit] ${business.name}: ${label} ${event.severity}`));
          }
          result.structured = { loanId, actions, smsText, emailBody, bankSummary, deliveries };
        },
      });
      results.push({
        loanId,
        status: "advised",
        loanState: state.state,
        conversationId: conversation.id,
        reply: turn.reply,
        ...turn.structured,
        citations: turn.citations,
        warnings: turn.warnings,
      });
    }
    return { alertId: event.alertId, hazard, results };
  }

  async function handleDamageReport(input: { loanId: string; message?: string } & Damage) {
    const { loanId, message, ...rest } = input;
    const parsed = damageSchema.safeParse(rest);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BadRequestError(`Invalid damage report: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`);
    }
    const { business, loan } = await requireLoan(loanId);
    const current = await loanState(loan);
    const damage: Damage = { ...current.damage, ...parsed.data, reportedOn: parsed.data.reportedOn ?? istToday(now()) };
    const state = transition(current, "damageReported", "damage report submitted", now(), { damage, alertId: null });
    await repo.saveLoanState(state);
    const conversation = await repo.createConversation({ businessId: business.id, loanId, mode: "recovery" });
    const fields = Object.entries(parsed.data)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
    return runTurn({
      conversation,
      business,
      loan,
      state,
      input: message ?? `Damage report submitted${fields ? ` (${fields})` : ""}. Please help me with a repayment plan.`,
      storeInput: true,
    });
  }

  // The monitor's verification step labels an alert a "hit" (README §5 Mode 3)
  async function handleVerification(alertId: string, label: "hit" | "miss") {
    const moved: string[] = [];
    if (label !== "hit") return { alertId, moved };
    for (const record of await repo.listLoansInState("ALERT")) {
      if (record.alertId !== alertId) continue;
      await repo.saveLoanState(
        transition(record, "verifiedHit", `alert ${alertId} verified as a hit`, now(), { alertId: null }),
      );
      moved.push(record.loanId);
    }
    return { alertId, moved };
  }

  // ── Bank actions ─────────────────────────────────────────────────────────

  async function decideProposal(
    id: string,
    decision: { decision: "accept" | "reject"; note?: string; decidedBy?: string },
  ) {
    const proposal = await repo.getProposal(id);
    if (!proposal) throw new NotFoundError(`Proposal ${id} not found`);
    if (proposal.status !== "pending_bank") throw new ConflictError(`Proposal ${id} is already ${proposal.status}`);
    const { loan } = await requireLoan(proposal.loanId);
    const state = await loanState(loan);
    if (decision.decision === "accept" && state.state !== "IMPACTED") {
      throw new ConflictError(`Loan ${loan.loanId} is ${state.state}; only an IMPACTED loan can enter RECOVERY`);
    }
    const decided = await repo.decideProposal(id, {
      status: decision.decision === "accept" ? "accepted" : "rejected",
      decidedBy: decision.decidedBy ?? "bank",
      note: decision.note ?? null,
      at: now(),
    });
    if (!decided) throw new ConflictError(`Proposal ${id} was decided by someone else`);
    let next = state;
    if (decision.decision === "accept") {
      next = transition(state, "proposalAccepted", `proposal ${id} accepted by ${decided.decidedBy ?? "bank"}`, now());
      await repo.saveLoanState(next);
    }
    return { proposal: viewProposal(decided), loanState: { loanId: next.loanId, state: next.state } };
  }

  async function getLoanState(loanId: string) {
    const { business, loan } = await requireLoan(loanId);
    const state = await loanState(loan);
    return {
      loanId,
      businessId: business.id,
      state: state.state,
      mode: modeFor(state.state),
      alertId: state.alertId,
      damage: state.damage,
      history: state.history,
    };
  }

  async function bankTransition(loanId: string, event: "disbursed" | "recoveryClosed", note?: string) {
    const { loan } = await requireLoan(loanId);
    const patch = event === "recoveryClosed" ? { damage: null } : {};
    await repo.saveLoanState(transition(await loanState(loan), event, note ?? `bank: ${event}`, now(), patch));
    return getLoanState(loanId);
  }

  async function getConversations(businessId: string) {
    await requireBusiness(businessId);
    const conversations = await repo.listConversations(businessId);
    return {
      businessId,
      conversations: await Promise.all(
        conversations.map(async (conversation) => ({
          ...conversation,
          createdAt: conversation.createdAt.toISOString(),
          messages: (await repo.listMessages(conversation.id)).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            structuredOutput: m.structuredOutput,
            citations: m.citations,
            createdAt: m.createdAt.toISOString(),
          })),
          // So every citation can be followed to the tool output behind it
          toolCalls: await repo.listToolCalls(conversation.id),
        })),
      ),
    };
  }

  // Loans whose alert window has ended with no damage go back to ACTIVE
  async function sweepAlerts(): Promise<string[]> {
    const moved: string[] = [];
    const at = now();
    for (const record of await repo.listLoansInState("ALERT")) {
      const event = record.alertId ? await repo.getAlertEvent(record.alertId) : null;
      if (event && Date.parse(event.windowEnd) > at.getTime()) continue;
      await repo.saveLoanState(
        transition(record, "alertEnded", "alert window ended with no damage reported", at, { alertId: null }),
      );
      moved.push(record.loanId);
    }
    return moved;
  }

  return {
    handleChat,
    handleAlert,
    handleDamageReport,
    handleVerification,
    decideProposal,
    markDisbursed: (loanId: string, note?: string) => bankTransition(loanId, "disbursed", note),
    closeRecovery: (loanId: string, note?: string) => bankTransition(loanId, "recoveryClosed", note),
    getLoanState,
    getConversations,
    sweepAlerts,
    // Which business a loan belongs to, so the caller can check access first
    businessOfLoan: async (loanId: string) => (await requireLoan(loanId)).business.id,
    businessOfProposal: async (id: string) => {
      const proposal = await repo.getProposal(id);
      if (!proposal) throw new NotFoundError(`Proposal ${id} not found`);
      return (await requireLoan(proposal.loanId)).business.id;
    },
    listBusinesses: async () =>
      (await directory.list()).map((b) => ({
        id: b.id,
        name: b.name,
        sector: b.sector,
        city: b.city,
        loans: b.loans.map((l) => l.loanId),
      })),
  };
}

export type Advisor = ReturnType<typeof createAdvisor>;
