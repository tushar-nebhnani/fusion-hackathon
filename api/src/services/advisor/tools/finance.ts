import { MONTHS, type BusinessRecord, type LoanRecord, type LoanStateName } from "../types.js";
import { outstanding, rupees } from "./money.js";
import { netOperatingIncome } from "./scenario.js";

// Revenue by month, expenses, existing debt and loans: the `business` part
// of getEvaluation, which the advisor's own cash-flow maths runs on. The
// figures come from the business record: the input service's latest
// snapshot (inputDirectory.ts) or, for a demo business, smes.json. The
// finance service's scores are in the evaluation beside it.
export function businessFinances(
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
