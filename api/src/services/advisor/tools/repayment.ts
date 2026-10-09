import type { Damage } from "../types.js";
import type { Cashflow } from "./cashflow.js";
import { dscr, emi, monthKey, monthlyRate, monthsBetween, ratio, rupees, type OutstandingLoan } from "./money.js";

export interface ScheduleRow {
  n: number;
  month: string;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

export type OptionKind = "moratorium" | "tenure_extension" | "step_down_up" | "insurance_bridge";

export interface RepaymentOption {
  kind: OptionKind;
  title: string;
  terms: string;
  reliefMonths: number;
  // Regular EMI once the relief period is over
  newEmi: number;
  // EMI during the relief period (0 for a moratorium)
  reliefEmi: number;
  prepayment: number;
  months: number;
  endMonth: string;
  totalPaid: number;
  totalInterest: number;
  extraCostVsOriginal: number;
  // Over the 12 months of the recomputed cash flow
  minMonthlyDSCR: number | null;
  minMonthlyDSCRMonth: string | null;
  // Over the same 12 months: debt due beyond what income covers
  cashShortfall: number;
  schedule: ScheduleRow[];
}

export interface RepaymentInput {
  loan: OutstandingLoan & { annualRatePct: number };
  cashflow: Cashflow;
  otherDebtMonthly: number;
  insuranceClaim?: Damage["insuranceClaim"];
}

export interface RepaymentResult {
  startMonth: string;
  outstandingBalance: number;
  remainingMonths: number;
  original: Omit<RepaymentOption, "kind" | "title" | "terms">;
  options: RepaymentOption[];
}

// Share of an insurance payout put towards the loan; the rest restocks
export const BRIDGE_PREPAY_SHARE = 0.5;
// Relief months are kept within this range
const MAX_RELIEF_MONTHS = 6;
const EXTENSION_MONTHS = 12;
const STEP_DOWN_SHARE = 0.5;

interface Plan {
  // Payment due in month i (0-based)
  payment: (i: number) => number;
  months: number;
  // Lump sum paid on top of the payment in month i
  prepayment?: (i: number) => number;
}

// Runs a plan month by month. Interest not covered by a payment is added to
// the balance, so a moratorium capitalises interest. The last month clears
// whatever is left, so every schedule closes at zero.
export function amortise(balance: number, annualRatePct: number, start: string, plan: Plan): ScheduleRow[] {
  const r = monthlyRate(annualRatePct);
  const rows: ScheduleRow[] = [];
  let left = balance;
  for (let i = 0; i < plan.months && left > 0.005; i += 1) {
    const interest = left * r;
    const owed = left + interest;
    const due = i === plan.months - 1 ? owed : Math.min(plan.payment(i), owed);
    const paid = due + Math.min(plan.prepayment?.(i) ?? 0, owed - due);
    left = owed - paid;
    rows.push({
      n: i + 1,
      month: monthKey(`${start}-01`, i),
      payment: rupees(paid),
      interest: rupees(interest),
      principal: rupees(paid - interest),
      balance: rupees(Math.max(0, left)),
    });
  }
  return rows;
}

function summarise(
  rows: ScheduleRow[],
  balance: number,
  cashflow: Cashflow,
  otherDebtMonthly: number,
  originalInterest: number,
) {
  const totalPaid = rows.reduce((sum, row) => sum + row.payment, 0);
  const totalInterest = rupees(totalPaid - balance);
  let minMonthlyDSCR: number | null = null;
  let minMonthlyDSCRMonth: string | null = null;
  let cashShortfall = 0;
  cashflow.months.forEach((month, i) => {
    const due = (rows[i]?.payment ?? 0) + otherDebtMonthly;
    cashShortfall += Math.max(0, due - Math.max(0, month.netOperatingIncome));
    const value = dscr(month.netOperatingIncome, due);
    if (value !== null && (minMonthlyDSCR === null || value < minMonthlyDSCR)) {
      minMonthlyDSCR = value;
      minMonthlyDSCRMonth = month.month;
    }
  });
  return {
    months: rows.length,
    endMonth: rows.at(-1)?.month ?? "",
    totalPaid: rupees(totalPaid),
    totalInterest,
    extraCostVsOriginal: rupees(totalInterest - originalInterest),
    minMonthlyDSCR: minMonthlyDSCR === null ? null : ratio(minMonthlyDSCR),
    minMonthlyDSCRMonth,
    cashShortfall: rupees(cashShortfall),
    schedule: rows,
  };
}

// Months of relief: the stretch at the start of the projection where income
// does not cover the current EMI plus other debt, kept between 1 and 6
export function reliefMonths(cashflow: Cashflow, debtService: number): number {
  let months = 0;
  cashflow.months.slice(0, MAX_RELIEF_MONTHS).forEach((month, i) => {
    if (month.netOperatingIncome < debtService) months = i + 1;
  });
  return Math.max(1, months);
}

const plural = (count: number) => `${count} month${count === 1 ? "" : "s"}`;

// README §7: three or four options, each with a full schedule
export function generateRepaymentOptions(input: RepaymentInput): RepaymentResult {
  const { loan, cashflow, otherDebtMonthly } = input;
  const start = cashflow.months[0]?.month ?? "";
  const rate = loan.annualRatePct;
  const r = monthlyRate(rate);
  const B = loan.balance;
  const n = loan.remainingMonths;
  if (n < 1 || B <= 0) throw new Error("The loan has no outstanding balance to restructure");

  const currentEmi = emi(B, rate, n);
  const originalRows = amortise(B, rate, start, { payment: () => currentEmi, months: n });
  const originalInterest = rupees(originalRows.reduce((sum, row) => sum + row.payment, 0) - B);
  const original = {
    reliefMonths: 0,
    newEmi: rupees(currentEmi),
    reliefEmi: rupees(currentEmi),
    prepayment: 0,
    ...summarise(originalRows, B, cashflow, otherDebtMonthly, originalInterest),
  };

  const m = Math.min(reliefMonths(cashflow, currentEmi + otherDebtMonthly), Math.max(1, n - 1));
  const options: RepaymentOption[] = [];
  const add = (
    head: { kind: OptionKind; title: string; terms: string },
    rows: ScheduleRow[],
    terms: { reliefMonths: number; newEmi: number; reliefEmi: number; prepayment?: number },
  ) =>
    options.push({
      ...head,
      reliefMonths: terms.reliefMonths,
      newEmi: rupees(terms.newEmi),
      reliefEmi: rupees(terms.reliefEmi),
      prepayment: rupees(terms.prepayment ?? 0),
      ...summarise(rows, B, cashflow, otherDebtMonthly, originalInterest),
    });

  // 1. Moratorium: nothing due for m months, interest added to principal,
  //    then a new EMI over the original remaining tenure
  {
    const after = emi(B * (1 + r) ** m, rate, n);
    add(
      {
        kind: "moratorium",
        title: `Moratorium of ${plural(m)}`,
        terms:
          "No EMI during the moratorium. Interest accrues and is added to the balance, then the EMI is recalculated over the original remaining tenure.",
      },
      amortise(B, rate, start, { payment: (i) => (i < m ? 0 : after), months: m + n }),
      { reliefMonths: m, newEmi: after, reliefEmi: 0 },
    );
  }

  // 2. Tenure extension: same balance, longer term, lower EMI from now on
  {
    const after = emi(B, rate, n + EXTENSION_MONTHS);
    add(
      {
        kind: "tenure_extension",
        title: `Tenure extended by ${plural(EXTENSION_MONTHS)}`,
        terms: "The outstanding balance is spread over a longer term, which lowers every EMI.",
      },
      amortise(B, rate, start, { payment: () => after, months: n + EXTENSION_MONTHS }),
      { reliefMonths: n + EXTENSION_MONTHS, newEmi: after, reliefEmi: after },
    );
  }

  // 3. Step-down / step-up: half EMI for m months, then a higher EMI that
  //    still closes the loan on its original date
  if (n - m >= 1) {
    const reduced = currentEmi * STEP_DOWN_SHARE;
    const growth = (1 + r) ** m;
    const left = r === 0 ? B - reduced * m : B * growth - (reduced * (growth - 1)) / r;
    const after = emi(left, rate, n - m);
    add(
      {
        kind: "step_down_up",
        title: `Half EMI for ${plural(m)}, then stepped up`,
        terms:
          "A reduced EMI during the recovery months, then a higher EMI so the loan still closes on its original date.",
      },
      amortise(B, rate, start, { payment: (i) => (i < m ? reduced : after), months: n }),
      { reliefMonths: m, newEmi: after, reliefEmi: reduced },
    );
  }

  // 4. Insurance bridge: only with a claim that has an amount and a date
  const claim = input.insuranceClaim;
  if (
    claim &&
    (claim.status === "filed" || claim.status === "approved") &&
    claim.expectedAmountInr &&
    claim.expectedDate
  ) {
    const claimIndex = Math.max(0, monthsBetween(`${start}-01`, claim.expectedDate));
    if (claimIndex < n - 1) {
      const prepay = claim.expectedAmountInr * BRIDGE_PREPAY_SHARE;
      const atClaim = B * (1 + r) ** (claimIndex + 1) - prepay;
      const after = atClaim > 0 ? emi(atClaim, rate, n - claimIndex - 1) : 0;
      add(
        {
          kind: "insurance_bridge",
          title: "Insurance bridge",
          terms: `No EMI until the insurance payout, then ${Math.round(BRIDGE_PREPAY_SHARE * 100)}% of the payout is prepaid and the EMI is recalculated to close on the original date.`,
        },
        amortise(B, rate, start, {
          payment: (i) => (i <= claimIndex ? 0 : after),
          prepayment: (i) => (i === claimIndex ? prepay : 0),
          months: n,
        }),
        { reliefMonths: claimIndex + 1, newEmi: after, reliefEmi: 0, prepayment: prepay },
      );
    }
  }

  return { startMonth: start, outstandingBalance: rupees(B), remainingMonths: n, original, options };
}
