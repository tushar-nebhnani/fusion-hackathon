// Pure loan arithmetic shared by scenario.ts, cashflow.ts and repayment.ts
// (README §7). Nothing here touches I/O, and the model never does this math.

export const rupees = (value: number) => Math.round(value);
export const ratio = (value: number) => Math.round(value * 100) / 100;

export function daysInMonth(year: number, month: number): number {
  // month is 1-12; day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export const monthlyRate = (annualRatePct: number) => annualRatePct / 12 / 100;

// P × r × (1+r)^n / ((1+r)^n − 1), and P / n when the rate is zero
export function emi(principal: number, annualRatePct: number, months: number): number {
  if (months <= 0) throw new Error("emi: months must be positive");
  const r = monthlyRate(annualRatePct);
  if (r === 0) return principal / months;
  const growth = (1 + r) ** months;
  return (principal * r * growth) / (growth - 1);
}

// Largest principal an EMI of `payment` can repay over `months`
export function principalFor(payment: number, annualRatePct: number, months: number): number {
  if (payment <= 0) return 0;
  const r = monthlyRate(annualRatePct);
  if (r === 0) return payment * months;
  const growth = (1 + r) ** months;
  return (payment * (growth - 1)) / (r * growth);
}

// The annual rate at which `payment` repays `principal` over `months`, for a
// loan entered with its EMI but no rate. 0 when the EMIs do not cover the
// principal; capped at 60%, the most a loan record allows.
export function annualRateFor(principal: number, payment: number, months: number): number {
  if (payment * months <= principal) return 0;
  let low = 0;
  let high = 60;
  for (let i = 0; i < 50; i += 1) {
    const mid = (low + high) / 2;
    if (emi(principal, mid, months) > payment) high = mid;
    else low = mid;
  }
  return ratio(low);
}

// Balance left after `paid` regular payments of `payment`
export function balanceAfter(
  principal: number,
  annualRatePct: number,
  payment: number,
  paid: number,
): number {
  const r = monthlyRate(annualRatePct);
  if (r === 0) return Math.max(0, principal - payment * paid);
  const growth = (1 + r) ** paid;
  return Math.max(0, principal * growth - (payment * (growth - 1)) / r);
}

export type DscrFlag = "ok" | "watch" | "critical";

// README §7: flag below 1.2, critical below 1.0
export function dscrFlag(value: number | null): DscrFlag {
  if (value === null) return "ok";
  if (value < 1) return "critical";
  if (value < 1.2) return "watch";
  return "ok";
}

// Null when nothing is due, so "no payment" never reads as a coverage problem.
// Negative income is no coverage at all: 0, not a negative ratio that would
// make a smaller payment look worse.
export function dscr(netOperatingIncome: number, debtService: number): number | null {
  return debtService > 0 ? ratio(Math.max(0, netOperatingIncome) / debtService) : null;
}

const utc = (isoDate: string) => new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);

// Whole calendar months from one ISO date to another (day of month ignored)
export function monthsBetween(fromIso: string, toIso: string): number {
  const from = utc(fromIso);
  const to = utc(toIso);
  return (
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
  );
}

// "2026-11" for the month `offset` months after the month of `isoDate`
export function monthKey(isoDate: string, offset = 0): string {
  const date = utc(isoDate);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export interface LoanTerms {
  principal: number;
  annualRatePct: number;
  tenureMonths: number;
}

export interface OutstandingLoan {
  balance: number;
  emi: number;
  remainingMonths: number;
  paidMonths: number;
}

// Where a loan stands on `asOf`, assuming every EMI so far was paid on time
export function outstanding(
  terms: LoanTerms,
  disbursedOn: string | null,
  asOf: string,
): OutstandingLoan {
  const payment = emi(terms.principal, terms.annualRatePct, terms.tenureMonths);
  const paid = disbursedOn
    ? Math.min(terms.tenureMonths, Math.max(0, monthsBetween(disbursedOn, asOf)))
    : 0;
  return {
    balance: balanceAfter(terms.principal, terms.annualRatePct, payment, paid),
    emi: payment,
    remainingMonths: terms.tenureMonths - paid,
    paidMonths: paid,
  };
}
