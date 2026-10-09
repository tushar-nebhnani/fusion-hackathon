import { MONTHS, type BusinessRecord, type LoanRecord, type LoanStateName } from "../types.js";
import { outstanding, rupees } from "./money.js";
import { netOperatingIncome } from "./scenario.js";

// STUB for the finance unit, which does not exist yet (NOTES.md). Reads the
// business's finance block from smes.json and shapes it like README §6 says
// getFinanceProfile returns: revenue by month, expenses, existing debt, loans.
export function getFinanceProfile(
  business: BusinessRecord,
  loanStates: Map<string, LoanStateName>,
  today: string,
) {
  const { finance } = business;
  const byMonth = <T>(values: T[]) => Object.fromEntries(MONTHS.map((name, i) => [name, values[i]]));
  return {
    source: "stub: api/data/smes.json (finance unit not built yet)",
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
