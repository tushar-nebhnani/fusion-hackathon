import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../errors/app-error.js";
import { invalidCitations, numbersIn, sourceNumbers, ungroundedNumbers, verdictFloor } from "../checks.js";
import { fitSms } from "../index.js";
import { modeFor, transition, type LoanStateRecord } from "../state.js";
import type { ScenarioResult } from "../tools/scenario.js";

describe("numbersIn", () => {
  it("reads rupees in Indian notation, lakh/k suffixes and percentages", () => {
    expect(numbersIn("₹3,00,000 or ₹3L or Rs 40k, 18% and DSCR 0.97").map((n) => n.value)).toEqual([
      300_000, 300_000, 40_000, 18, 0.97,
    ]);
  });

  it("ignores dates, times, ids, call references and small counts", () => {
    expect(numbersIn("On 2026-10-09 at 6:00 pm, see call_3.revenueLoss for LN-0101; 2 questions, rank 1")).toEqual([]);
  });
});

describe("ungroundedNumbers", () => {
  const sources = sourceNumbers([
    { revenueLoss: 32_516, dscrStressed: 0.97, revenueLossPct: 18.05, label: "Thu 15 Oct" },
  ]);

  it("accepts numbers that match a source within display rounding", () => {
    expect(ungroundedNumbers(["a loss of ₹32,516 (18%), DSCR 0.97 by Thu 15 Oct"], sources)).toEqual([]);
  });

  it("flags numbers that no tool produced", () => {
    expect(ungroundedNumbers(["a loss of ₹45,000 and DSCR 1.4"], sources)).toEqual(["₹45,000", "1.4"]);
  });
});

describe("invalidCitations", () => {
  const calls = [
    { callId: "call_1", output: { options: [{ newEmi: 100 }] } },
    { callId: "call_2", error: "climate down" },
  ];
  it("needs a successful call and a field that exists", () => {
    expect(
      invalidCitations(["call_1", "call_1.options[0].newEmi", "call_1.nope", "call_2", "call_7"], calls),
    ).toEqual(["call_1.nope", "call_2", "call_7"]);
  });
});

describe("verdictFloor", () => {
  const scenario = (dscrStressed: number, lowestNormalDscr: number) =>
    ({ dscrStressed, lowestNormalDscr }) as ScenarioResult;
  it("follows the DSCR thresholds", () => {
    expect(verdictFloor([scenario(1.5, 1.6)])).toBe("viable");
    expect(verdictFloor([scenario(0.8, 1.3)])).toBe("viable_with_conditions");
    expect(verdictFloor([scenario(0.8, 0.9)])).toBe("high_risk");
  });
});

describe("loan state machine", () => {
  const loan: LoanStateRecord = { loanId: "L", state: "PRE_LOAN", history: [], damage: null, alertId: null };
  const at = new Date("2026-10-09T00:00:00Z");

  it("follows README §4 and records each transition", () => {
    const active = transition(loan, "disbursed", "bank", at);
    const alerted = transition(active, "alert", "rain", at, { alertId: "a1" });
    const impacted = transition(alerted, "verifiedHit", "hit", at);
    const recovery = transition(impacted, "proposalAccepted", "bank", at);
    expect(recovery.state).toBe("RECOVERY");
    expect(recovery.history.map((h) => h.to)).toEqual(["ACTIVE", "ALERT", "IMPACTED", "RECOVERY"]);
    expect(modeFor(alerted.state)).toBe("alert");
    expect(modeFor(recovery.state)).toBe("recovery");
    expect(modeFor(null)).toBe("preLoan");
  });

  it("rejects transitions the diagram does not have", () => {
    expect(() => transition(loan, "alert", "x", at)).toThrow(ConflictError);
    expect(() => transition(loan, "proposalAccepted", "x", at)).toThrow(ConflictError);
  });
});

describe("fitSms", () => {
  it("keeps the reply prompt and stays within 160 characters", () => {
    const sms = fitSms(
      "Kshetra WARNING: flood from Fri 9 Oct, 11:30 pm IST.",
      "x ".repeat(200),
      "Reply or open chat.",
    );
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(sms.endsWith("Reply or open chat.")).toBe(true);
  });
});
