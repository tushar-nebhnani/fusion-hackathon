import type { BusinessRecord, Damage } from "../types.js";
import { daysInMonth, monthKey, rupees } from "./money.js";
import { netOperatingIncome } from "./scenario.js";

const DAY_MS = 86_400_000;
export const PROJECTION_MONTHS = 12;

export interface CashflowMonth {
  month: string;
  revenue: number;
  closedDays: number;
  revenueLoss: number;
  incomeLoss: number;
  // Restocking and repairs, paid in the month the shop reopens
  directLoss: number;
  insuranceInflow: number;
  netOperatingIncome: number;
}

export interface Cashflow {
  closure: { start: string; reopen: string; totalDays: number };
  months: CashflowMonth[];
  totals: { revenueLoss: number; incomeLoss: number; directLoss: number; insuranceInflow: number };
}

// Fields recomputeCashflow needs; missingDamageFields() lists what is absent
export type CompleteDamage = Damage &
  Required<Pick<Damage, "daysClosed" | "stockLossInr" | "equipmentDamageInr" | "expectedReopenDate">> & {
    reportedOn: string;
  };

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const day = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`);

// The shop was closed `daysClosed` days up to the report and stays closed
// until `expectedReopenDate`. A closed shop sells nothing that day, so the
// classifier's sensitivity does not apply here.
export function recomputeCashflow(finance: BusinessRecord["finance"], damage: CompleteDamage): Cashflow {
  const reported = day(damage.reportedOn);
  const start = reported - damage.daysClosed * DAY_MS;
  const reopen = Math.max(day(damage.expectedReopenDate), reported);
  const startIso = iso(start);
  const reopenIso = iso(reopen);

  const claim = damage.insuranceClaim;
  const payout =
    claim && (claim.status === "filed" || claim.status === "approved") && claim.expectedDate
      ? { month: claim.expectedDate.slice(0, 7), amount: claim.expectedAmountInr ?? 0 }
      : null;
  const directLoss = damage.stockLossInr + damage.equipmentDamageInr;

  const months: CashflowMonth[] = [];
  for (let offset = 0; offset < PROJECTION_MONTHS; offset += 1) {
    const key = monthKey(startIso, offset);
    const [year, month] = key.split("-").map(Number) as [number, number];
    const first = Date.UTC(year, month - 1, 1);
    const days = daysInMonth(year, month);
    const next = first + days * DAY_MS;
    const closedDays = Math.max(0, Math.min(next, reopen) - Math.max(first, start)) / DAY_MS;

    const revenue = finance.monthlyRevenue[month - 1] ?? 0;
    const revenueLoss = (revenue / days) * closedDays;
    const incomeLoss = revenueLoss * (1 - finance.variableCostShare);
    const direct = key === reopenIso.slice(0, 7) ? directLoss : 0;
    const inflow = payout && payout.month === key ? payout.amount : 0;

    months.push({
      month: key,
      revenue: rupees(revenue),
      closedDays: Math.round(closedDays),
      revenueLoss: rupees(revenueLoss),
      incomeLoss: rupees(incomeLoss),
      directLoss: rupees(direct),
      insuranceInflow: rupees(inflow),
      netOperatingIncome: rupees(netOperatingIncome(finance, revenue) - incomeLoss - direct + inflow),
    });
  }

  const sum = (pick: (row: CashflowMonth) => number) =>
    months.reduce((total, row) => total + pick(row), 0);
  return {
    closure: { start: startIso, reopen: reopenIso, totalDays: Math.round((reopen - start) / DAY_MS) },
    months,
    totals: {
      revenueLoss: sum((row) => row.revenueLoss),
      incomeLoss: sum((row) => row.incomeLoss),
      directLoss: sum((row) => row.directLoss),
      insuranceInflow: sum((row) => row.insuranceInflow),
    },
  };
}
