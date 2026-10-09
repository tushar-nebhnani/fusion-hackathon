import { MONTHS, type BusinessRecord, type LoanRecord, type LoanStateName } from "../types.js";
import { outstanding, rupees } from "./money.js";
import { netOperatingIncome } from "./scenario.js";

// The finance service's latest stored profile, as the advisor shows it
export interface FinanceScore {
  baselineScore: number;
  // null when no climate profile could be applied
  climateAdjustedScore: number | null;
  scoredAt: string;
  modelVersion: string;
}

// Revenue by month, expenses, existing debt and loans, as README §6 says
// getFinanceProfile returns. The figures come from the business record: the
// input service's latest snapshot (inputDirectory.ts) or, for a demo
// business, smes.json.
export function getFinanceProfile(
  business: BusinessRecord,
  loanStates: Map<string, LoanStateName>,
  today: string,
) {
  const { finance } = business;
  const byMonth = <T>(values: T[]) => Object.fromEntries(MONTHS.map((name, i) => [name, values[i]]));
  return {
    source:
      business.origin === "input"
        ? "input service: latest financial snapshot"
        : "demo business: api/data/smes.json",
    businessId: business.id,
    monthlyRevenue: byMonth(finance.monthlyRevenue),
    annualRevenue: rupees(finance.monthlyRevenue.reduce((sum, value) => sum + value, 0)),
    variableCostShare: finance.variableCostShare,
    fixedMonthlyCosts: finance.fixedMonthlyCosts,
    monthlyNetOperatingIncome: byMonth(
      finance.monthlyRevenue.map((revenue) => rupees(netOperatingIncome(finance, revenue))),
    ),
    otherDebtMonthly: finance.otherDebtMonthly,
    loans: business.loans.map((loan) =>
      describeLoan(loan, loanStates.get(loan.loanId) ?? loan.initialState, today),
    ),
  };
}

export function describeLoan(loan: LoanRecord, state: LoanStateName, today: string) {
  const position = outstanding(loan, loan.disbursedOn, today);
  return {
    loanId: loan.loanId,
    state,
    principal: loan.principal,
    annualRatePct: loan.annualRatePct,
    tenureMonths: loan.tenureMonths,
    disbursedOn: loan.disbursedOn,
    emi: rupees(position.emi),
    outstandingBalance: rupees(position.balance),
    remainingMonths: position.remainingMonths,
  };
}
