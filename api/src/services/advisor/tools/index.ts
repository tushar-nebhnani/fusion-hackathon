import { z } from "zod";
import type { EvaluatorService } from "../../evaluator/service.js";
import type { LlmTool } from "../llm/client.js";
import type { AdvisorRepository } from "../repository.js";
import type { LoanStateRecord } from "../state.js";
import {
  HAZARDS,
  damageSchema,
  hazardFromAlert,
  missingDamageFields,
  type AdvisorMode,
  type BusinessRecord,
  type Damage,
  type Hazard,
  type LoanRecord,
  type LoanStateName,
} from "../types.js";
import { recomputeCashflow, type CompleteDamage } from "./cashflow.js";
import { hazardSeasons } from "./climate.js";
import { businessFinances } from "./finance.js";
import { getBusinessFacts, saveBusinessFact } from "./memory.js";
import type { Channel, Messenger } from "./messaging.js";
import { outstanding } from "./money.js";
import { generateRepaymentOptions } from "./repayment.js";
import { simulateScenario } from "./scenario.js";
import { getWeatherImpact, sensitivityFor } from "./weatherImpact.js";

export interface ToolDeps {
  repo: AdvisorRepository;
  // The only way the advisor reaches the climate unit and the finance
  // service: their answers come checked, with one combined rating
  evaluator: Pick<EvaluatorService, "evaluate">;
  messenger: Messenger;
}

// What a tool may touch. The business and loan come from the request, never
// from the model's arguments, so a tool call cannot reach another business.
export interface ToolContext {
  conversationId: string;
  business: BusinessRecord;
  loan: LoanRecord | null;
  loanState: LoanStateRecord | null;
  alertId: string | null;
  now: Date;
}

interface ToolDefinition<Input> {
  name: string;
  description: string;
  schema: z.ZodType<Input>;
  // Modes whose model is offered this tool; [] means code-only
  modes: AdvisorMode[];
  run(input: Input, ctx: ToolContext, deps: ToolDeps): Promise<unknown>;
  // A shorter view for the model; the full output is still logged
  forModel?(output: unknown): unknown;
}

const tool = <Input>(definition: ToolDefinition<Input>) => definition as ToolDefinition<unknown>;
const ALL: AdvisorMode[] = ["preLoan", "alert", "recovery"];
const empty = z.object({});
const IST_OFFSET_MS = 5.5 * 3_600_000;
const HOUR_MS = 3_600_000;

export const istToday = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// "Thu 15 Oct, 6:00 pm IST", so the model never converts time zones
export function istLabel(iso: string): string {
  const label = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
  return `${label} IST`;
}

async function loanStates(ctx: ToolContext, repo: AdvisorRepository) {
  const states = new Map<string, LoanStateName>();
  for (const loan of ctx.business.loans) {
    const record = await repo.getLoanState(loan.loanId);
    if (record) states.set(loan.loanId, record.state);
  }
  return states;
}

function completeDamage(ctx: ToolContext): CompleteDamage {
  const damage: Damage = ctx.loanState?.damage ?? {};
  const missing = missingDamageFields(damage);
  if (missing.length > 0) throw new Error(`Damage details missing: ${missing.join(", ")}`);
  return { ...(damage as CompleteDamage), reportedOn: damage.reportedOn ?? istToday(ctx.now) };
}

const cashflowFor = (ctx: ToolContext) => recomputeCashflow(ctx.business.finance, completeDamage(ctx));

export function repaymentOptionsFor(ctx: ToolContext) {
  if (!ctx.loan) throw new Error("No loan is attached to this conversation");
  const loan = ctx.loan;
  const cashflow = cashflowFor(ctx);
  const asOf = `${cashflow.months[0]?.month ?? istToday(ctx.now).slice(0, 7)}-01`;
  return generateRepaymentOptions({
    loan: { ...outstanding(loan, loan.disbursedOn, asOf), annualRatePct: loan.annualRatePct },
    cashflow,
    otherDebtMonthly: ctx.business.finance.otherDebtMonthly,
    insuranceClaim: ctx.loanState?.damage?.insuranceClaim,
  });
}

interface ScenarioArgs {
  hazard: Hazard;
  durationDays: number;
  month: number;
  loanAmount?: number;
  annualRatePct?: number;
  tenureMonths?: number;
  extraCosts?: number;
}

export const TOOLS: ToolDefinition<unknown>[] = [
  tool({
    name: "getBusinessFacts",
    description:
      "Facts known about the business (from chat, the onboarding form or the bank) and the risk facts still missing, in the order to ask them.",
    schema: empty,
    modes: ALL,
    run: (_input, ctx, deps) => getBusinessFacts(deps.repo, ctx.business),
  }),
  tool({
    name: "saveBusinessFact",
    description:
      "Store one fact the owner told you, e.g. key stock_perishable, storage_level, insurance, revenue_pattern, road_power_dependency. Use the owner's words for the value.",
    schema: z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      value: z.string().min(1).max(300),
    }),
    modes: ALL,
    run: ({ key, value }: { key: string; value: string }, ctx, deps) =>
      saveBusinessFact(deps.repo, ctx.business.id, key, value, "owner_chat"),
  }),
  tool({
    name: "getEvaluation",
    description:
      "The evaluated climate and finance picture for this business. rating (favourable / acceptable / caution / unfavourable / insufficient_data), reliable, reasons and checks come from the evaluator. climate is the climate unit's profile: grade, each hazard's relevance (primary/secondary/dormant), score 0-1 and reason, and active forecast events; null when unavailable. finance is the finance service's baseline and climate-adjusted score (0-100, higher is safer) with its drivers; null for a business it does not know. business has the revenue by month, costs, monthly net operating income, other debt and loan details. If reliable is false or climate is null, say the data is unavailable and give no verdict.",
    schema: empty,
    modes: ALL,
    run: async (_input, ctx, deps) => {
      const { business } = ctx;
      const evaluation = await deps.evaluator.evaluate({
        businessId: business.id,
        point: { lat: business.lat, lon: business.lon },
        requesterId: `advisor:${business.id}`,
      });
      return {
        ...evaluation,
        business: businessFinances(business, await loanStates(ctx, deps.repo), istToday(ctx.now)),
      };
    },
  }),
  tool({
    name: "getHazardSeasons",
    description: "Months each hazard usually strikes in this region. Use it to pick the month for simulateScenario.",
    schema: empty,
    modes: ["preLoan"],
    run: (_input, ctx) => Promise.resolve(hazardSeasons(ctx.business)),
  }),
  tool({
    name: "getWeatherImpact",
    description:
      'How each hazard affects this business: effect favourable/unfavourable/neutral, sensitivity 0-1 and reason. effect "unknown" means it has not been rated; say so, do not assume.',
    schema: empty,
    modes: ALL,
    run: (_input, ctx) => Promise.resolve(getWeatherImpact(ctx.business)),
  }),
  tool({
    name: "getAlertContext",
    description:
      "The alert event behind this conversation, with the hazard, window and ready-made deadline labels in IST. Use these labels for deadlines.",
    schema: z.object({ alertId: z.string().optional() }),
    modes: ["alert"],
    async run({ alertId }: { alertId?: string }, ctx, deps) {
      const id = alertId ?? ctx.alertId;
      const event = id ? await deps.repo.getAlertEvent(id) : null;
      if (!event) throw new Error(`Alert ${id ?? "(none)"} was not found`);
      const start = Date.parse(event.windowStart);
      // Six hours before the window, or now if that has passed
      const prepareBy = new Date(Math.max(ctx.now.getTime(), start - 6 * HOUR_MS)).toISOString();
      return {
        // An alert lists every loan it covers; other businesses' stay out
        event: { ...event, loanIds: event.loanIds.filter((loanId) => loanId === ctx.loan?.loanId) },
        hazard: hazardFromAlert(event.hazard),
        severity: event.severity,
        hoursUntilWindowStart: Math.round((start - ctx.now.getTime()) / HOUR_MS),
        windowStartLabel: istLabel(event.windowStart),
        windowEndLabel: istLabel(event.windowEnd),
        prepareBy,
        prepareByLabel: istLabel(prepareBy),
      };
    },
  }),
  tool({
    name: "simulateScenario",
    description:
      "Simulate a hazard closing the business for some days in one month: revenue loss, stressed net income, EMI and DSCR, and the largest principal that keeps DSCR at 1.0 (stressed month) and 1.2 (ordinary months). Without loanAmount it uses this conversation's loan.",
    schema: z.object({
      hazard: z.enum(HAZARDS),
      durationDays: z.number().int().min(1).max(31),
      month: z.number().int().min(1).max(12),
      loanAmount: z.number().positive().optional(),
      annualRatePct: z.number().min(0).max(60).optional(),
      tenureMonths: z.number().int().min(1).max(360).optional(),
      extraCosts: z.number().nonnegative().optional(),
    }),
    modes: ["preLoan"],
    run(input: ScenarioArgs, ctx) {
      const base = ctx.loan ?? ctx.business.loans[0];
      const loan = {
        principal: input.loanAmount ?? base?.principal ?? 0,
        annualRatePct: input.annualRatePct ?? base?.annualRatePct ?? 14,
        tenureMonths: input.tenureMonths ?? base?.tenureMonths ?? 24,
        source: input.loanAmount ? "amount asked about in chat" : base ? `loan ${base.loanId}` : "none",
      };
      if (loan.principal <= 0) throw new Error("No loan amount: ask the owner how much they want to borrow");
      const current = new Date(ctx.now.getTime() + IST_OFFSET_MS);
      // The next time this month comes round
      const year = current.getUTCFullYear() + (input.month < current.getUTCMonth() + 1 ? 1 : 0);
      return Promise.resolve(
        simulateScenario({
          finance: ctx.business.finance,
          hazard: input.hazard,
          durationDays: input.durationDays,
          month: input.month,
          year,
          ...sensitivityFor(ctx.business, input.hazard),
          loan,
          extraCosts: input.extraCosts,
        }),
      );
    },
  }),
  tool({
    name: "getDamageReport",
    description:
      "Damage reported for this loan so far, and the fields still missing before options can be computed.",
    schema: empty,
    modes: ["recovery"],
    run: (_input, ctx) => {
      const damage = ctx.loanState?.damage ?? {};
      return Promise.resolve({
        loanId: ctx.loan?.loanId ?? null,
        state: ctx.loanState?.state ?? null,
        damage,
        missingFields: missingDamageFields(damage),
      });
    },
  }),
  tool({
    name: "saveDamageDetails",
    description:
      "Store damage details the owner gave in chat. Pass only the fields they stated. Amounts in rupees, dates as YYYY-MM-DD. insuranceClaim.status is none, planned, filed or approved.",
    schema: damageSchema.omit({ reportedOn: true }),
    modes: ["recovery"],
    async run(input: Damage, ctx, deps) {
      const record = ctx.loanState;
      if (!record || record.state !== "IMPACTED") {
        throw new Error("Damage can only be recorded while the loan is IMPACTED");
      }
      const damage = { ...record.damage, ...input };
      ctx.loanState = { ...record, damage };
      await deps.repo.saveLoanState(ctx.loanState);
      return { damage, missingFields: missingDamageFields(damage) };
    },
  }),
  tool({
    name: "recomputeCashflow",
    description: "12-month projected cash flow after the reported damage. Fails if damage details are missing.",
    schema: empty,
    modes: ["recovery"],
    run: (_input, ctx) => Promise.resolve(cashflowFor(ctx)),
  }),
  tool({
    name: "generateRepaymentOptions",
    description:
      "Repayment options for this loan against the recomputed cash flow: moratorium, tenure extension, step-down/step-up and (with an insurance claim) an insurance bridge, each with new EMI, total interest, extra cost and lowest monthly DSCR. Fails if damage details are missing.",
    schema: empty,
    modes: ["recovery"],
    run: (_input, ctx) => Promise.resolve(repaymentOptionsFor(ctx)),
    // Full schedules are stored; the model sees the first rows only
    forModel: (output) => {
      const result = output as ReturnType<typeof generateRepaymentOptions>;
      return {
        ...result,
        original: { ...result.original, schedule: result.original.schedule.slice(0, 3) },
        options: result.options.map((option) => ({ ...option, schedule: option.schedule.slice(0, 3) })),
      };
    },
  }),
  tool({
    name: "sendMessage",
    description: "Send an SMS or email through the existing alert sender.",
    schema: z.object({
      channel: z.enum(["sms", "email"]),
      to: z.string().nullable(),
      subject: z.string().optional(),
      body: z.string().min(1),
    }),
    // Code-only: alert messages are composed and sent by index.ts
    modes: [],
    run: (input: { channel: Channel; to: string | null; subject?: string; body: string }, _ctx, deps) =>
      deps.messenger.send(input),
  }),
];

const byName = new Map(TOOLS.map((definition) => [definition.name, definition]));

export function toolsFor(mode: AdvisorMode): LlmTool[] {
  return TOOLS.filter((definition) => definition.modes.includes(mode)).map((definition) => {
    const { $schema: _ignored, ...parameters } = z.toJSONSchema(definition.schema) as Record<string, unknown>;
    return { name: definition.name, description: definition.description, parameters };
  });
}

export interface ToolResult {
  callId: string;
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  // What goes back to the model
  forModel: unknown;
}

// Runs tools for one conversation. Every call gets the next call_n id and a
// row in advisor_tool_calls, success or not.
export function createToolRunner(deps: ToolDeps, ctx: ToolContext, firstCallNumber: number) {
  let next = firstCallNumber;
  return {
    async run(name: string, args: unknown, mode: AdvisorMode | "code"): Promise<ToolResult> {
      const callId = `call_${next}`;
      next += 1;
      const started = Date.now();
      const definition = byName.get(name);
      const input = args ?? {};
      let output: unknown;
      let error: string | undefined;
      try {
        if (!definition) throw new Error(`Unknown tool ${name}`);
        if (mode !== "code" && !definition.modes.includes(mode)) {
          throw new Error(`Tool ${name} is not available in ${mode} mode`);
        }
        const parsed = definition.schema.safeParse(input);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(`Invalid arguments: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim());
        }
        output = await definition.run(parsed.data, ctx, deps);
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "tool failed";
      }
      await deps.repo.addToolCall({
        conversationId: ctx.conversationId,
        callId,
        tool: name,
        input,
        output: error ? null : output,
        error: error ?? null,
        durationMs: Date.now() - started,
      });
      if (error) return { callId, tool: name, input, error, forModel: { callId, tool: name, error } };
      return {
        callId,
        tool: name,
        input,
        output,
        forModel: { callId, result: definition?.forModel ? definition.forModel(output) : output },
      };
    },
  };
}
