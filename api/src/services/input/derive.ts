import { invalidFinancials } from "./errors.js";
import type { Financials } from "./schemas/index.js";

// The ratios of README section 3. Field names match smes.json.
export interface DerivedFinancials {
  avg_revenue: number;
  // Coefficient of variation of the monthly revenue
  revenue_volatility: number;
  NOI_month: number;
  operating_margin: number;
  debt_service_month: number;
  // EMI of loans not yet being repaid, already inside debt_service_month
  proposed_loan_emi: number;
  // null when there is no debt to service
  dscr: number | null;
  debt_to_revenue: number;
  // null when there are no operating costs to cover
  cash_buffer_days: number | null;
  years_in_operation: number;
  num_locations: number;
}

export interface DeriveContext {
  yearStarted: number;
  currentYear: number;
  additionalLocations: number;
  // Sum of the EMIs of this business's applied and authorised loans
  proposedLoanEmi: number;
}

const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export function deriveFinancials(raw: Financials, context: DeriveContext): DerivedFinancials {
  const months = raw.monthly_revenue;
  const avg = months.reduce((sum, month) => sum + month, 0) / months.length;
  if (avg === 0) {
    throw invalidFinancials("monthly_revenue needs at least one month above zero");
  }

  // Population standard deviation: the months are the whole history given
  const variance = months.reduce((sum, month) => sum + (month - avg) ** 2, 0) / months.length;
  const noi = avg - raw.monthly_opex;
  const debtService = raw.existing_emi_total + context.proposedLoanEmi;

  return {
    avg_revenue: round(avg, 2),
    revenue_volatility: round(Math.sqrt(variance) / avg, 4),
    NOI_month: round(noi, 2),
    operating_margin: round(noi / avg, 4),
    debt_service_month: debtService,
    proposed_loan_emi: context.proposedLoanEmi,
    // A loss gives a DSCR at or below zero; the finance service reads that
    // as the highest risk
    dscr: debtService === 0 ? null : round(noi / debtService, 4),
    debt_to_revenue: round(raw.outstanding_debt / (avg * 12), 4),
    cash_buffer_days:
      raw.monthly_opex === 0 ? null : round(raw.cash_balance / (raw.monthly_opex / 30), 1),
    years_in_operation: Math.max(0, context.currentYear - context.yearStarted),
    num_locations: 1 + context.additionalLocations,
  };
}
