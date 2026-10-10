import type { ClimateProfile } from "../../climate/schema.js";
import { numbersIn } from "../checks.js";
import { materialHazards, monthNumber } from "../tools/climate.js";
import type { RepaymentResult } from "../tools/repayment.js";
import type { ScenarioResult } from "../tools/scenario.js";
import type { Hazard, MonthName, RiskFactKey } from "../types.js";
import type { LlmClient, LlmMessage, LlmReply } from "./client.js";

// The parts of getEvaluation's output the planner reads
interface EvaluationView {
  reliable: boolean;
  checks: { status: string; detail: string }[];
  climate: ClimateProfile | null;
  business?: { loans?: { loanId: string; emi: number; outstandingBalance: number; remainingMonths: number }[] };
}

// A deterministic stand-in for the model, used when no API key is set
// (ADVISOR_LLM_PROVIDER=offline). It drives the same tool loop the model
// does: it picks tools from the conversation so far, then writes the answer
// from template sentences filled with tool results only. It exists so the
// demo and the acceptance checks run without a key.

interface Seen {
  callId: string;
  result?: unknown;
  error?: string;
}

interface Context {
  mode: "preLoan" | "alert" | "recovery";
  today: string;
  business: { id: string; name: string; sector: string };
  loan: { loanId: string; state: string | null; principal: number } | null;
  generalQuestionsOnActiveLoan: boolean;
  questionRoundsSoFar: number;
  alertId: string | null;
}

interface Turn {
  // What the owner (or the alert trigger) said this turn
  input: string;
  earlierUserText: string[];
  // Latest result per tool this turn
  seen: Map<string, Seen>;
  // Every simulateScenario result this turn, in order
  scenarios: { callId: string; result: ScenarioResult }[];
  // Facts saved this turn, which getBusinessFacts read before they existed
  savedFacts: Map<string, string>;
}

const DURATION: Record<Hazard, number> = {
  river_flood: 7,
  flash_flood: 3,
  storm: 4,
  heat: 10,
  drought: 20,
  cold_wave: 5,
};

const LABEL: Record<Hazard, string> = {
  river_flood: "river flood",
  flash_flood: "flash flood",
  storm: "storm",
  heat: "heatwave",
  drought: "drought",
  cold_wave: "cold wave",
};

const QUESTIONS: Record<RiskFactKey, string> = {
  stock_perishable: "Is most of your stock perishable (vegetables, dairy, cooked food) or dry goods?",
  storage_level: "Where is your stock kept: on the ground floor, or on raised shelves / an upper floor?",
  insurance: "Do you have insurance for your shop and stock, and does it cover floods and storms?",
  revenue_pattern: "Do your sales change a lot by season? Which months are strongest and weakest?",
  road_power_dependency: "Does your business stop if the road is cut or the power goes off?",
};

const DAMAGE_QUESTIONS: Record<string, string> = {
  daysClosed: "How many days has the shop been closed so far?",
  stockLossInr: "Roughly how much stock was lost, in rupees?",
  equipmentDamageInr: "Was any equipment damaged? If so, what will repairs cost in rupees (say 0 if none)?",
  expectedReopenDate: "On what date do you expect to reopen (YYYY-MM-DD)?",
  insuranceClaim: "Have you filed an insurance claim? If yes, how much do you expect and by what date?",
  "insuranceClaim.expectedAmountInr": "How much do you expect from the insurance claim?",
  "insuranceClaim.expectedDate": "By what date do you expect the insurance money (YYYY-MM-DD)?",
};

const STOCK_WORDS: Record<string, string> = {
  kirana: "rice, dal and other stock",
  food: "flour, dairy and baked stock",
  "agri-inputs": "seed and fertiliser bags",
  tailoring: "fabric and finished orders",
};

const inr = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;
const list = (items: string[]) => items.map((item, i) => `${i + 1}. ${item}`).join("\n");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readContext(messages: LlmMessage[]): Context {
  const system = messages.find((m) => m.role === "system");
  const text = system && "content" in system ? (system.content ?? "") : "";
  // The block closes the prompt; the prose above it also says "<context>"
  const match = /<context>\n([\s\S]*)\n<\/context>\s*$/.exec(text);
  return (match?.[1] ? parseJson(match[1]) : {}) as Context;
}

// Everything since the last real user message; history before it carries no
// tool messages, only text
function readTurn(messages: LlmMessage[]): Turn {
  let start = 0;
  messages.forEach((m, i) => {
    if (m.role === "user" && !m.content.startsWith("Finish by calling")) start = i;
  });
  const names = new Map<string, string>();
  const seen = new Map<string, Seen>();
  const scenarios: Turn["scenarios"] = [];
  const savedFacts = new Map<string, string>();
  for (const message of messages.slice(start)) {
    if (message.role === "assistant") for (const c of message.toolCalls ?? []) names.set(c.id, c.name);
    if (message.role !== "tool") continue;
    const name = names.get(message.toolCallId) ?? "";
    const body = parseJson(message.content) as { callId?: string; result?: unknown; error?: string } | null;
    if (name === "respond" || !body?.callId) continue;
    seen.set(name, { callId: body.callId, result: body.result, error: body.error });
    if (name === "simulateScenario" && body.result) {
      scenarios.push({ callId: body.callId, result: body.result as ScenarioResult });
    }
    const fact = body.result as { key?: string; value?: string } | undefined;
    if (name === "saveBusinessFact" && fact?.key && fact.value) savedFacts.set(fact.key, fact.value);
  }
  return {
    input: (messages[start] as { content?: string } | undefined)?.content ?? "",
    earlierUserText: messages
      .slice(0, start)
      .flatMap((m) => (m.role === "user" ? [m.content] : [])),
    seen,
    scenarios,
    savedFacts,
  };
}

let counter = 0;
const call = (...calls: [string, unknown][]): LlmReply => ({
  content: null,
  toolCalls: calls.map(([name, args]) => {
    counter += 1;
    return { id: `offline_${counter}`, name, arguments: JSON.stringify(args) };
  }),
});
const respond = (args: unknown) => call(["respond", args]);
const fetch = (...names: string[]) => call(...names.map((name): [string, unknown] => [name, {}]));

// The amount the owner asked about, e.g. "₹3L" or "Rs 4,00,000"
function askedAmount(texts: string[]): number | null {
  for (const text of [...texts].reverse()) {
    const money = numbersIn(text).find((n) => !n.percent && n.value >= 10_000);
    if (money) return money.value;
  }
  return null;
}

function classifyFact(key: RiskFactKey, text: string): string {
  const lower = text.toLowerCase();
  const said = `owner said: "${text.trim().slice(0, 200)}"`;
  if (key === "stock_perishable") {
    if (/\b(no|not|non)[- ]?perish|dry|packaged|grain|rice|dal|fabric/.test(lower) && !/\byes\b/.test(lower)) {
      return `mostly dry goods (${said})`;
    }
    if (/perish|vegetable|dairy|milk|fruit|fresh|\byes\b/.test(lower)) return `yes, perishable (${said})`;
  }
  if (key === "storage_level") {
    if (/raised|rack|shel|upper|first floor|platform|plinth/.test(lower)) return `raised (${said})`;
    if (/ground|floor/.test(lower)) return `ground floor (${said})`;
  }
  if (key === "insurance") {
    if (/\bno\b|not insured|without/.test(lower)) return `none (${said})`;
    if (/insur|policy|cover/.test(lower)) return `insured (${said})`;
  }
  return said;
}

// ── Pre-loan ─────────────────────────────────────────────────────────────────

function preLoan(ctx: Context, turn: Turn): LlmReply {
  const { seen } = turn;
  const facts = seen.get("getBusinessFacts");
  if (!facts) return fetch("getBusinessFacts");
  const missing = (facts.result as { missingRiskFacts?: RiskFactKey[] } | undefined)?.missingRiskFacts ?? [];

  if (ctx.generalQuestionsOnActiveLoan) return activeLoan(ctx, turn);

  // First round: ask about the two most important missing facts, then stop
  if (missing.length > 0 && ctx.questionRoundsSoFar === 0) {
    const ask = missing.slice(0, 2).map((key) => QUESTIONS[key]);
    return respond({
      reply: `Before I assess this loan for ${ctx.business.name}, two quick questions that change your climate risk:\n${list(ask)}`,
      questions: ask,
      assessment: null,
      citations: [facts.callId],
    });
  }
  // Next round: the owner's answer covers the two facts asked last time
  if (missing.length > 0 && !seen.has("saveBusinessFact")) {
    return call(
      ...missing
        .slice(0, 2)
        .map((key): [string, unknown] => ["saveBusinessFact", { key, value: classifyFact(key, turn.input) }]),
    );
  }

  const needed = ["getEvaluation", "getWeatherImpact", "getHazardSeasons"];
  if (needed.some((name) => !seen.has(name))) return fetch(...needed.filter((name) => !seen.has(name)));

  // Only an evaluated, reliable answer is used; otherwise no verdict
  const evaluated = seen.get("getEvaluation");
  const evaluation = evaluated?.result as EvaluationView | undefined;
  if (!evaluation?.climate || !evaluation.reliable) {
    const failed = evaluation?.checks.filter((check) => check.status === "fail").map((check) => check.detail) ?? [];
    const why = failed[0] ?? evaluated?.error ?? "no result";
    return respond({
      reply: `Climate or finance data for your business is unavailable or could not be checked right now (${why}). I cannot give a fair verdict without it, so please try again shortly.`,
      questions: [],
      assessment: null,
      citations: [],
    });
  }
  const profile = evaluation.climate;
  const seasons = (seen.get("getHazardSeasons")?.result as { seasons?: Record<Hazard, MonthName[]> } | undefined)
    ?.seasons;

  if (turn.scenarios.length === 0) {
    const hazards = materialHazards(profile).slice(0, 3);
    const top = [...profile.hazards].sort((a, b) => b.score - a.score)[0];
    if (hazards.length === 0 && top) hazards.push(top.hazard);
    const amount = askedAmount([...turn.earlierUserText, turn.input]);
    return call(
      ...hazards.map((hazard): [string, unknown] => [
        "simulateScenario",
        {
          hazard,
          durationDays: DURATION[hazard],
          month: monthNumber(seasons?.[hazard]?.[0] ?? "Jul") ?? 7,
          ...(amount ? { loanAmount: amount } : {}),
        },
      ]),
    );
  }
  return respond(assessment(ctx, turn, facts, seasons ?? null));
}

function activeLoan(ctx: Context, turn: Turn): LlmReply {
  const finance = turn.seen.get("getEvaluation");
  if (!finance) return fetch("getEvaluation");
  const loans = (finance.result as EvaluationView | undefined)?.business?.loans ?? [];
  const index = loans.findIndex((l) => l.loanId === ctx.loan?.loanId);
  const loan = loans[index];
  return respond({
    reply: loan
      ? `Your loan ${loan.loanId} is active. The EMI is ${inr(loan.emi)} and ${inr(loan.outstandingBalance)} is outstanding, with ${loan.remainingMonths} EMIs to go. I will message you if a climate alert affects your area, and I can help plan repayments if a calamity hits the business.`
      : "Your loan is active, but its details are unavailable right now.",
    questions: [],
    assessment: null,
    citations: loan
      ? [`${finance.callId}.business.loans[${index}].emi`, `${finance.callId}.business.loans[${index}].outstandingBalance`]
      : [],
  });
}

function assessment(ctx: Context, turn: Turn, facts: Seen, seasons: Record<Hazard, MonthName[]> | null) {
  const scenarios = turn.scenarios;
  const lowestNormal = Math.min(...scenarios.map((s) => s.result.lowestNormalDscr ?? Infinity));
  const lowestStressed = Math.min(...scenarios.map((s) => s.result.dscrStressed ?? Infinity));
  const verdict =
    lowestNormal < 1 ? "high_risk" : lowestStressed < 1.2 || lowestNormal < 1.2 ? "viable_with_conditions" : "viable";
  const factValue = (key: string) =>
    (
      turn.savedFacts.get(key) ??
      ((facts.result as { facts?: { key: string; value: string }[] } | undefined)?.facts ?? []).find(
        (f) => f.key === key,
      )?.value ??
      ""
    ).toLowerCase();

  const risks = scenarios.map(({ callId, result: s }) => ({
    hazard: s.hazard,
    months: seasons?.[s.hazard] ?? [s.month as MonthName],
    impact:
      `A ${s.durationDaysApplied}-day ${LABEL[s.hazard]} in ${s.month} could cut sales by about ${inr(s.revenueLoss)} (${s.revenueLossPct}% of that month). ` +
      `Net income that month would fall from ${inr(s.normalNetOperatingIncome)} to ${inr(s.stressedNetOperatingIncome)}, against an EMI of ${inr(s.loan.emi)}; DSCR goes from ${s.dscrNormal ?? "n/a"} to ${s.dscrStressed ?? "n/a"} (${s.dscrFlag}).` +
      (s.sensitivitySource === "weather_impact"
        ? ""
        : " How this hazard affects your business has not been rated, so this assumes a full loss on the closure days."),
    citations: [`${callId}.revenueLoss`, `${callId}.stressedNetOperatingIncome`, `${callId}.dscrStressed`],
  }));

  const suggestions: string[] = [];
  for (const { result: s } of scenarios) {
    if (s.dscrFlag === "ok") continue;
    const months = seasons?.[s.hazard] ?? [s.month];
    suggestions.push(`EMI holiday or reduced EMI in ${months.join("–")} for the ${LABEL[s.hazard]} season, subject to your bank's policy`);
  }
  const wet = scenarios.some((s) => ["river_flood", "flash_flood", "storm"].includes(s.result.hazard));
  if (wet && !/insured|flood/.test(factValue("insurance"))) suggestions.push("Insure shop stock against flood and storm damage");
  if (wet && /ground/.test(factValue("storage_level"))) {
    suggestions.push("Raise stock storage onto racks or an upper floor before the monsoon");
  }
  const worst = [...scenarios].sort((a, b) => (a.result.dscrStressed ?? Infinity) - (b.result.dscrStressed ?? Infinity))[0];
  if (worst && verdict !== "viable") {
    const w = worst.result;
    suggestions.push(
      w.maxPrincipalStressDscr1 > 0
        ? `Consider a smaller amount, up to ${inr(w.maxPrincipalStressDscr1)}, which the stressed ${w.month} can still cover`
        : `A stressed ${w.month} cannot cover any EMI; build a cash reserve before borrowing`,
    );
  }
  const unique = [...new Set(suggestions)].slice(0, 5);

  const verdictText = {
    viable: "looks viable",
    viable_with_conditions: "looks viable with conditions",
    high_risk: "looks high risk",
  }[verdict];
  const first = scenarios[0]?.result;
  const weakMonth =
    first && first.lowestNormalDscr !== null && first.lowestNormalDscr < 1
      ? ` Even in an ordinary ${first.lowestNormalMonth}, income does not cover the EMI (DSCR ${first.lowestNormalDscr}).`
      : "";
  const summary = `A loan of ${first ? inr(first.loan.principal) : "this size"} ${verdictText} for ${ctx.business.name}.${weakMonth} Climate risks checked: ${scenarios.map((s) => LABEL[s.result.hazard]).join(", ")}.`;
  const bankSummary = worst
    ? `${ctx.business.name}: ${verdict.replace(/_/g, " ")}. Worst simulated DSCR ${worst.result.dscrStressed ?? "n/a"} (${LABEL[worst.result.hazard]}, ${worst.result.month}); lowest ordinary-month DSCR ${worst.result.lowestNormalDscr ?? "n/a"} (${worst.result.lowestNormalMonth}).`
    : `${ctx.business.name}: no scenario could be run.`;
  const climate = turn.seen.get("getEvaluation");
  return {
    reply: [
      summary,
      "",
      ...risks.map((r) => `• ${r.impact}`),
      "",
      unique.length > 0
        ? `What would make it safer:\n${list(unique)}`
        : "No special loan conditions are needed for the risks I checked.",
      "",
      "This is advice only. The bank makes the lending decision.",
    ].join("\n"),
    questions: [],
    assessment: { verdict, summary, risks, loanStructureSuggestions: unique, bankSummary },
    citations: [
      facts.callId,
      ...(climate ? [`${climate.callId}.climate.grade`] : []),
      ...(worst ? [`${worst.callId}.maxPrincipalStressDscr1`, `${worst.callId}.lowestNormalDscr`] : []),
    ],
  };
}

// ── Alert ────────────────────────────────────────────────────────────────────

function alertAdvice(ctx: Context, turn: Turn): LlmReply {
  const { seen } = turn;
  if (!seen.has("getAlertContext")) {
    return call(["getAlertContext", ctx.alertId ? { alertId: ctx.alertId } : {}], ["getBusinessFacts", {}], ["getWeatherImpact", {}]);
  }
  const alertCall = seen.get("getAlertContext");
  if (!alertCall?.result) {
    return respond({
      reply: `The alert details are unavailable right now (${alertCall?.error ?? "no result"}). Please protect your stock and records and follow local authority advice.`,
      actions: [],
      bankSummary: "",
      citations: [],
    });
  }
  const alert = alertCall.result as {
    hazard: Hazard | null;
    severity: string;
    prepareBy: string;
    prepareByLabel: string;
    windowStartLabel: string;
    windowEndLabel: string;
    event: { windowStart: string };
  };
  const hazard = alert.hazard ?? "flash_flood";
  const impact = seen.get("getWeatherImpact");
  const entry = (impact?.result as { hazards?: Record<string, { sensitivity?: number; reason?: string }> } | undefined)
    ?.hazards?.[hazard];
  const facts = JSON.stringify(seen.get("getBusinessFacts")?.result ?? {}).toLowerCase();
  const perishable = /perishable|dairy|vegetable|baked/.test(facts) && !/dry goods/.test(facts);
  const stock = STOCK_WORDS[ctx.business.sector] ?? "stock";
  const by = alert.prepareByLabel;
  const why = entry?.reason
    ? `${entry.reason}${entry.sensitivity !== undefined ? ` (sensitivity ${entry.sensitivity})` : ""}`
    : "How this hazard affects your business has not been rated, so plan for the worst case.";
  const papers: [string, string] = [
    `Put the cash book, bills, insurance and loan papers in a waterproof bag before ${by}`,
    "Records are needed for any insurance or bank relief claim.",
  ];

  const plans: Record<string, [string, string][]> = {
    flood: [
      [`Move ${stock} off the ground floor onto racks or an upper floor before ${by}`, why],
      papers,
      ["Photograph your stock and shop today, so any damage claim has proof", "Photos taken before the event make claims faster."],
      ...(perishable
        ? [[`Sell down or shift perishable stock before ${alert.windowStartLabel}`, "Perishable stock cannot be saved once the shop closes."] as [string, string]]
        : []),
      ["Switch off the mains power if water starts entering the shop", "Prevents equipment damage and electric shock."],
    ],
    storm: [
      [`Bring loose boards and signs inside and close the shutters before ${by}`, why],
      [`Charge phones and the inverter and keep a torch ready before ${alert.windowStartLabel}`, "Power cuts are likely during a storm."],
      ...(perishable
        ? [["Run down cold stock so a long power cut does not spoil it", "Cold stock spoils within hours without power."] as [string, string]]
        : []),
      papers,
    ],
    heat: [
      [`Move heavy work to early morning and evening from ${alert.windowStartLabel}`, why],
      ["Keep drinking water and ORS ready for staff and customers", "Heat illness can close the shop for days."],
      ...(perishable
        ? [["Keep perishable stock cool and order smaller quantities this week", "Heat shortens shelf life."] as [string, string]]
        : []),
      ["Check the power backup for fans and cooling", "Power cuts are common during heatwaves."],
    ],
    other: [
      [`Protect ${stock} and key equipment before ${by}`, why],
      papers,
      ["Follow local authority advice and tell your bank early if you have to close", "The bank can only help if it knows early."],
    ],
  };
  const group = hazard === "river_flood" || hazard === "flash_flood" ? "flood" : hazard in plans ? hazard : "other";
  const cite = [alertCall.callId];
  const actions = (plans[group] ?? []).slice(0, 5).map(([action, reason], i) => ({
    rank: i + 1,
    action,
    deadline: i < 2 ? alert.prepareBy : alert.event.windowStart,
    why: reason,
    citations: i === 0 && impact ? [...cite, `${impact.callId}.hazards.${hazard}`] : cite,
  }));

  const followUp = !/alert \(id /.test(turn.input);
  return respond({
    reply: followUp
      ? `The ${alert.severity} ${LABEL[hazard]} alert is still in force from ${alert.windowStartLabel} to ${alert.windowEndLabel}. The most urgent step is still: ${actions[0]?.action ?? "protect your stock"}.`
      : `A ${alert.severity} ${LABEL[hazard]} alert is in force for your area from ${alert.windowStartLabel} to ${alert.windowEndLabel}. Here is what to do, most urgent first. Reply here with any question.`,
    actions: followUp ? [] : actions,
    bankSummary: `${ctx.business.name}: ${alert.severity} ${LABEL[hazard]} from ${alert.windowStartLabel} to ${alert.windowEndLabel}. Main exposure: ${entry?.reason ?? "not rated"}. Owner advised to protect stock and records.`,
    citations: cite,
  });
}

// ── Recovery ─────────────────────────────────────────────────────────────────

function parseDamage(text: string, today: string): Record<string, unknown> {
  const lower = text.toLowerCase();
  const damage: Record<string, unknown> = {};
  const days = /closed (?:for )?(\d{1,3}) days?|(\d{1,3}) days? closed/.exec(lower);
  if (days) damage.daysClosed = Number(days[1] ?? days[2]);
  const amountNear = (pattern: RegExp) => {
    // A comma between digits groups them (₹1,20,000), so it does not end a clause
    for (const clause of text.split(/;|,(?!\d)|\band\b|\.\s/i)) {
      if (!pattern.test(clause.toLowerCase())) continue;
      const amount = numbersIn(clause).find((n) => !n.percent);
      if (amount) return amount.value;
      if (/\bno\b|none|nothing|zero/.test(clause.toLowerCase())) return 0;
    }
    return undefined;
  };
  const stock = amountNear(/stock/);
  if (stock !== undefined) damage.stockLossInr = stock;
  const equipment = amountNear(/equipment|machine|fridge|oven|repair/);
  if (equipment !== undefined) damage.equipmentDamageInr = equipment;
  const reopen = /reopen\w*\s(?:on\s)?(\d{4}-\d{2}-\d{2})/.exec(lower);
  if (reopen) damage.expectedReopenDate = reopen[1];
  else if (/already (re)?open|reopened|open again/.test(lower)) damage.expectedReopenDate = today;
  if (/no insurance|not insured|no claim|without insurance/.test(lower)) damage.insuranceClaim = { status: "none" };
  else if (/claim/.test(lower)) {
    const date = /claim[^.]*?(\d{4}-\d{2}-\d{2})/.exec(lower);
    const amount = amountNear(/claim/);
    damage.insuranceClaim = {
      status: /approved/.test(lower) ? "approved" : "filed",
      ...(amount ? { expectedAmountInr: amount } : {}),
      ...(date ? { expectedDate: date[1] } : {}),
    };
  }
  return damage;
}

function recovery(ctx: Context, turn: Turn): LlmReply {
  const { seen } = turn;
  const report = seen.get("getDamageReport");
  if (!report) return fetch("getDamageReport");
  if ((report.result as { state?: string } | undefined)?.state === "RECOVERY") {
    return respond({
      reply: "Your bank has accepted a revised repayment plan for this loan. Ask your bank officer for the new schedule, or tell me if your situation changes again.",
      questions: [],
      recommendation: null,
      citations: [report.callId],
    });
  }

  const saved = seen.get("saveDamageDetails");
  const missing =
    ((saved?.result ?? report.result) as { missingFields?: string[] } | undefined)?.missingFields ?? [];
  if (missing.length > 0 && !saved) {
    const parsed = parseDamage(turn.input, ctx.today);
    if (Object.keys(parsed).length > 0) return call(["saveDamageDetails", parsed]);
  }
  if (missing.length > 0) {
    const ask = missing.slice(0, 2).map((field) => DAMAGE_QUESTIONS[field] ?? `Please tell me: ${field}`);
    return respond({
      reply: `I'm sorry about the damage to ${ctx.business.name}. To work out a repayment plan I need a little more:\n${list(ask)}`,
      questions: ask,
      recommendation: null,
      citations: [saved?.callId ?? report.callId],
    });
  }

  const options = seen.get("generateRepaymentOptions");
  if (!options) return fetch("recomputeCashflow", "generateRepaymentOptions");
  if (!options.result) {
    return respond({
      reply: `I could not compute repayment options right now (${options.error ?? "no result"}). Your damage report is saved; please try again shortly.`,
      questions: [],
      recommendation: null,
      citations: [],
    });
  }
  const result = options.result as RepaymentResult;
  const id = options.callId;
  const indexed = result.options.map((option, i) => ({ option, i }));
  const safe = indexed.filter(({ option }) => (option.minMonthlyDSCR ?? Infinity) >= 1.2);
  const best = safe.length > 0
    ? [...safe].sort((a, b) => a.option.extraCostVsOriginal - b.option.extraCostVsOriginal)[0]
    : [...indexed].sort((a, b) => a.option.cashShortfall - b.option.cashShortfall)[0];
  const index = best?.i ?? 0;
  const chosen = result.options[index];
  const lines = result.options.map(
    (o, i) =>
      `${i + 1}. ${o.title}: ${o.reliefEmi !== o.newEmi ? `${inr(o.reliefEmi)} a month during relief, then ` : ""}EMI ${inr(o.newEmi)}. Extra cost ${inr(o.extraCostVsOriginal)}. Weakest month DSCR ${o.minMonthlyDSCR ?? "n/a"}.`,
  );
  const why = !chosen
    ? ""
    : safe.length > 0
      ? `It keeps every month's DSCR at ${chosen.minMonthlyDSCR ?? "n/a"} or better at the lowest extra cost, ${inr(chosen.extraCostVsOriginal)}.`
      : `No option keeps every month at a safe DSCR; this one leaves the smallest gap between income and payments over the next year (${inr(chosen.cashShortfall)}).`;
  return respond({
    reply: [
      `Your outstanding balance is ${inr(result.outstandingBalance)} with ${result.remainingMonths} EMIs left at ${inr(result.original.newEmi)}. On the current schedule your weakest month has a DSCR of ${result.original.minMonthlyDSCR ?? "n/a"}. Options:`,
      lines.join("\n"),
      "",
      `I suggest option ${index + 1}, ${chosen?.title ?? ""}. ${why}`,
      "",
      "I have sent this to your bank as a proposal. The bank decides; restructuring may be possible under natural-calamity relief norms, subject to your bank's policy.",
    ].join("\n"),
    questions: [],
    recommendation: { optionIndex: index, why },
    citations: [
      `${id}.outstandingBalance`,
      `${id}.original.minMonthlyDSCR`,
      ...result.options.flatMap((_, i) => [
        `${id}.options[${i}].newEmi`,
        `${id}.options[${i}].extraCostVsOriginal`,
        `${id}.options[${i}].minMonthlyDSCR`,
        `${id}.options[${i}].cashShortfall`,
      ]),
    ],
  });
}

export function createOfflineLlm(): LlmClient {
  return {
    version: "offline/deterministic-1",
    complete({ messages }) {
      const ctx = readContext(messages);
      const turn = readTurn(messages);
      if (ctx.mode === "alert") return Promise.resolve(alertAdvice(ctx, turn));
      if (ctx.mode === "recovery") return Promise.resolve(recovery(ctx, turn));
      return Promise.resolve(preLoan(ctx, turn));
    },
  };
}
