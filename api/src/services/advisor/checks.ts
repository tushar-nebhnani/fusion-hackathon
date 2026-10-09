import { z } from "zod";
import type { ScenarioResult } from "./tools/scenario.js";
import { HAZARDS, MONTHS } from "./types.js";

// ── What the model returns through the `respond` tool (README §5) ───────────

const citations = z.array(z.string().max(120)).max(40);

export const preLoanOutput = z.object({
  reply: z.string().min(1).max(4000),
  questions: z.array(z.string().max(300)).max(5),
  assessment: z
    .object({
      verdict: z.enum(["viable", "viable_with_conditions", "high_risk"]),
      summary: z.string().max(1000),
      risks: z
        .array(
          z.object({
            hazard: z.enum(HAZARDS),
            months: z.array(z.enum(MONTHS)).max(12),
            impact: z.string().max(600),
            citations,
          }),
        )
        .max(6),
      loanStructureSuggestions: z.array(z.string().max(300)).max(8),
      bankSummary: z.string().max(800),
    })
    .nullable(),
  citations,
});
export type PreLoanOutput = z.infer<typeof preLoanOutput>;

export const alertOutput = z.object({
  reply: z.string().min(1).max(4000),
  actions: z
    .array(
      z.object({
        rank: z.number().int().min(1).max(10),
        action: z.string().min(1).max(300),
        deadline: z.string().max(40),
        why: z.string().max(400),
        citations,
      }),
    )
    .max(8),
  bankSummary: z.string().max(800),
  citations,
});
export type AlertOutput = z.infer<typeof alertOutput>;

export const recoveryOutput = z.object({
  reply: z.string().min(1).max(5000),
  questions: z.array(z.string().max(300)).max(5),
  recommendation: z
    .object({ optionIndex: z.number().int().min(0).max(9), why: z.string().max(800) })
    .nullable(),
  citations,
});
export type RecoveryOutput = z.infer<typeof recoveryOutput>;

// Free-text fields whose numbers must trace to a source
export const textOf = {
  preLoan: (o: PreLoanOutput) => [
    o.reply,
    ...o.questions,
    ...(o.assessment
      ? [
          o.assessment.summary,
          o.assessment.bankSummary,
          ...o.assessment.loanStructureSuggestions,
          ...o.assessment.risks.map((risk) => risk.impact),
        ]
      : []),
  ],
  alert: (o: AlertOutput) => [o.reply, o.bankSummary, ...o.actions.flatMap((a) => [a.action, a.why])],
  recovery: (o: RecoveryOutput) => [o.reply, ...o.questions, o.recommendation?.why ?? ""],
};

export const citationsOf = {
  preLoan: (o: PreLoanOutput) => [
    ...o.citations,
    ...(o.assessment?.risks.flatMap((risk) => risk.citations) ?? []),
  ],
  alert: (o: AlertOutput) => [...o.citations, ...o.actions.flatMap((action) => action.citations)],
  recovery: (o: RecoveryOutput) => o.citations,
};

// ── Citations ────────────────────────────────────────────────────────────────

export interface CitableCall {
  callId: string;
  output?: unknown;
  error?: string | null;
}

// True when "options[1].newEmi" leads somewhere inside the output
function resolves(output: unknown, path: string): boolean {
  let current: unknown = output;
  for (const part of path.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== "")) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return false;
  }
  return true;
}

// Citations that do not point at a successful tool call, or at a field it has
export function invalidCitations(cited: string[], calls: CitableCall[]): string[] {
  const byId = new Map(calls.filter((call) => !call.error).map((call) => [call.callId, call.output]));
  return cited.filter((citation) => {
    const match = /^(call_\d+)(?:\.(.+))?$/.exec(citation.trim());
    if (!match?.[1] || !byId.has(match[1])) return true;
    return match[2] ? !resolves(byId.get(match[1]), match[2]) : false;
  });
}

// ── Numbers ──────────────────────────────────────────────────────────────────

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  l: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  cr: 1e7,
  crore: 1e7,
};
const NUMBER = /(₹|rs\.?\s?|inr\s?)?(\d[\d,]*(?:\.\d+)?)\s?(k|lakhs?|lac|l|crore|cr|%)?(?!\w)/gi;

export interface NumberMention {
  text: string;
  value: number;
  // Half a unit of the last digit shown, so "₹3L" matches ₹3,12,000 but not ₹4,00,000
  tolerance: number;
  percent: boolean;
}

// Dates, times, ids and call references are not claims to check
const NOT_NUMBERS = [
  /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /\b\d{4}-\d{2}\b/g,
  /\b\d{1,2}:\d{2}\s?(?:am|pm)?/gi,
  /\b\d{1,2}\s?(?:am|pm)\b/gi,
  /\bcall_\d+(?:\.[\w.[\]]+)?/g,
  /\b[A-Z]{2,}-\d+\b/g,
  /\b\d+(?:st|nd|rd|th)\b/gi,
];

export function numbersIn(text: string): NumberMention[] {
  let cleaned = text;
  for (const pattern of NOT_NUMBERS) cleaned = cleaned.replace(pattern, " ");
  const found: NumberMention[] = [];
  for (const match of cleaned.matchAll(NUMBER)) {
    const raw = match[2] ?? "";
    const suffix = (match[3] ?? "").toLowerCase();
    const percent = suffix === "%";
    const money = Boolean(match[1]) || (suffix !== "" && !percent);
    const base = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const multiplier = MULTIPLIERS[suffix] ?? 1;
    const decimals = raw.includes(".") ? (raw.split(".")[1]?.length ?? 0) : 0;
    const value = base * multiplier;
    // Small counts ("2 questions", "rank 1") and years carry no financial claim
    const smallCount = Number.isInteger(value) && value <= 12;
    const year = Number.isInteger(value) && value >= 1900 && value <= 2100;
    if (!money && !percent && (smallCount || year)) continue;
    found.push({ text: match[0].trim(), value, tolerance: 0.5 * 10 ** -decimals * multiplier, percent });
  }
  return found;
}

// Every number in tool results, tool inputs and what the owner said
export function sourceNumbers(sources: unknown[]): number[] {
  const values: number[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) values.push(Math.abs(value));
    else if (typeof value === "string") values.push(...numbersIn(value).map((m) => m.value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  sources.forEach(walk);
  return values;
}

// Numbers in the texts that match no source within display rounding
export function ungroundedNumbers(texts: string[], sources: number[]): string[] {
  const missing = new Set<string>();
  for (const mention of texts.flatMap(numbersIn)) {
    // "18%" may be a percentage field (18.05) or a share (0.18)
    const candidates = mention.percent
      ? [
          { value: mention.value, tolerance: mention.tolerance },
          { value: mention.value / 100, tolerance: mention.tolerance / 100 },
        ]
      : [{ value: mention.value, tolerance: mention.tolerance }];
    const grounded = candidates.some(({ value, tolerance }) =>
      sources.some((source) => Math.abs(source - value) <= Math.max(tolerance, source * 0.005) + 1e-9),
    );
    if (!grounded) missing.add(mention.text);
  }
  return [...missing];
}

// ── Mode guards ──────────────────────────────────────────────────────────────

const RANK = { viable: 0, viable_with_conditions: 1, high_risk: 2 } as const;
export type Verdict = keyof typeof RANK;

// The least severe verdict the scenario numbers allow. The model may go
// higher, never lower.
export function verdictFloor(scenarios: ScenarioResult[]): Verdict {
  if (scenarios.length === 0) return "viable";
  const lowestNormal = Math.min(...scenarios.map((s) => s.lowestNormalDscr ?? Infinity));
  const lowestStressed = Math.min(...scenarios.map((s) => s.dscrStressed ?? Infinity));
  if (lowestNormal < 1) return "high_risk";
  if (lowestStressed < 1.2 || lowestNormal < 1.2) return "viable_with_conditions";
  return "viable";
}

export const raiseVerdict = (model: Verdict, floor: Verdict): Verdict =>
  RANK[floor] > RANK[model] ? floor : model;

// README §1 rule 5: alert advice may add urgency, never dismiss the alert
const DISMISSIVE =
  /\b(ignore (this|the) (alert|warning)|safe to ignore|can be ignored|no need to (worry|act|prepare|do anything)|nothing to worry|not (a|any) (real )?concern|disregard)\b/i;

export const dismissivePhrases = (texts: string[]) =>
  texts.flatMap((text) => {
    const match = DISMISSIVE.exec(text);
    return match ? [match[0]] : [];
  });
