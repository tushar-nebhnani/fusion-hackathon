import { FINANCE } from "../config.js";

// The raw numbers a profile is computed from. They are stored with every
// profile, so each figure in it can be traced back to what was entered.
export interface FinanceInputs {
  // Oldest month first
  monthly_revenue: number[];
  // Average monthly operating cost, excluding loan repayments
  monthly_expenses: number;
  // What the business already repays each month
  existing_emi: number;
  // EMI of loans asked for or granted but not yet being repaid
  proposed_emi: number;
  outstanding_debt: number;
  // Principal of the loans behind `proposed_emi`
  proposed_principal: number;
  cash_reserves: number;
  missed_payments_12m: number;
  years_in_operation: number;
}

export type RepaymentRating = "clean" | "minor" | "watch" | "poor";

export interface FinanceMetrics {
  months_of_history: number;
  avg_monthly_revenue: number;
  avg_monthly_expenses: number;
  // Revenue less operating costs, before loan repayments
  net_monthly_cashflow: number;
  existing_emi: number;
  proposed_emi: number;
  total_emi: number;
  // null when there is no debt to service
  dscr: number | null;
  // What is left of a month's revenue after costs and repayments
  surplus_after_debt: number;
  cash_reserves: number;
  cash_runway: "positive_cashflow" | "burning";
  // Months the cash lasts at the current burn; null on positive cashflow
  cash_runway_months: number | null;
  // Months of costs and repayments the cash covers; null when there are none
  cash_buffer_months: number | null;
  // Coefficient of variation of the monthly revenue
  revenue_volatility: number;
  // Best month over the average month
  seasonality_index: number;
  // Total debt over a year's revenue
  leverage: number;
  repayment_record: { missed_payments_12m: number; rating: RepaymentRating };
  years_in_operation: number;
}

export const round = (value: number, places: number) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

// Standard amortisation: the level monthly payment that clears `principal`
// over `months` at a yearly rate of `annualRatePct` percent
export function amortisedEmi(principal: number, annualRatePct: number, months: number): number {
  if (principal <= 0 || months <= 0) return 0;
  const rate = annualRatePct / 12 / 100;
  if (rate === 0) return round(principal / months, 2);
  const growth = (1 + rate) ** months;
  return round((principal * rate * growth) / (growth - 1), 2);
}

export function repaymentRating(missed: number): RepaymentRating {
  for (const [rating, upTo] of FINANCE.baseline.repaymentRatings) {
    if (missed <= upTo) return rating;
  }
  return "poor";
}

// DSCR and runway for a given monthly revenue. The stress test calls this
// again with the shocked revenue, so both use one definition.
export function debtCover(input: { revenue: number; expenses: number; totalEmi: number; cash: number }) {
  const net = input.revenue - input.expenses;
  const surplus = net - input.totalEmi;
  const burning = surplus < 0;
  return {
    net_monthly_cashflow: round(net, 2),
    dscr: input.totalEmi === 0 ? null : round(net / input.totalEmi, 4),
    surplus_after_debt: round(surplus, 2),
    cash_runway: burning ? ("burning" as const) : ("positive_cashflow" as const),
    cash_runway_months: burning
      ? round(input.cash / Math.max(-surplus, FINANCE.metrics.epsilon), 1)
      : null,
  };
}

export function computeMetrics(inputs: FinanceInputs): FinanceMetrics {
  const months = inputs.monthly_revenue;
  const avg = months.reduce((sum, month) => sum + month, 0) / months.length;
  // Population standard deviation, as the input service derives it
  const variance = months.reduce((sum, month) => sum + (month - avg) ** 2, 0) / months.length;
  const totalEmi = inputs.existing_emi + inputs.proposed_emi;
  const outgoings = inputs.monthly_expenses + totalEmi;

  return {
    months_of_history: months.length,
    avg_monthly_revenue: round(avg, 2),
    avg_monthly_expenses: round(inputs.monthly_expenses, 2),
    existing_emi: inputs.existing_emi,
    proposed_emi: inputs.proposed_emi,
    total_emi: round(totalEmi, 2),
    ...debtCover({
      revenue: avg,
      expenses: inputs.monthly_expenses,
      totalEmi,
      cash: inputs.cash_reserves,
    }),
    cash_reserves: inputs.cash_reserves,
    cash_buffer_months: outgoings === 0 ? null : round(inputs.cash_reserves / outgoings, 1),
    revenue_volatility: avg === 0 ? 0 : round(Math.sqrt(variance) / avg, 4),
    seasonality_index: avg === 0 ? 0 : round(Math.max(...months) / avg, 4),
    leverage:
      avg === 0 ? 0 : round((inputs.outstanding_debt + inputs.proposed_principal) / (avg * 12), 4),
    repayment_record: {
      missed_payments_12m: inputs.missed_payments_12m,
      rating: repaymentRating(inputs.missed_payments_12m),
    },
    years_in_operation: inputs.years_in_operation,
  };
}
