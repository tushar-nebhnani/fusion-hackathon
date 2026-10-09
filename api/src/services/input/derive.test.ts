import { describe, expect, it } from "vitest";
import { deriveFinancials, type DeriveContext } from "./derive.js";
import { financialsSchema, type Financials } from "./schemas/index.js";
import { financialsBody } from "./testing/fixtures.js";

const CONTEXT: DeriveContext = {
  yearStarted: 2015,
  currentYear: 2026,
  additionalLocations: 2,
  proposedLoanEmi: 0,
};

const financials = (overrides: Record<string, unknown> = {}): Financials =>
  financialsSchema.parse(financialsBody(overrides));

describe("deriveFinancials", () => {
  it("computes every ratio of README section 3", () => {
    // Revenue 80k..120k, mean 100,000; opex 60,000; EMIs 10,000; debt
    // 240,000; cash 90,000
    const derived = deriveFinancials(financials(), CONTEXT);

    expect(derived).toEqual({
      avg_revenue: 100_000,
      // Population standard deviation 12,909.94 over the mean
      revenue_volatility: 0.1291,
      NOI_month: 40_000,
      operating_margin: 0.4,
      debt_service_month: 10_000,
      proposed_loan_emi: 0,
      dscr: 4,
      // 240,000 / (100,000 x 12)
      debt_to_revenue: 0.2,
      // 90,000 / (60,000 / 30)
      cash_buffer_days: 45,
      years_in_operation: 11,
      num_locations: 3,
    });
  });

  it("adds the EMI of a loan that is not being repaid yet to the debt service", () => {
    const derived = deriveFinancials(financials(), { ...CONTEXT, proposedLoanEmi: 10_000 });

    expect(derived.debt_service_month).toBe(20_000);
    expect(derived.proposed_loan_emi).toBe(10_000);
    expect(derived.dscr).toBe(2);
  });

  it("gives zero volatility for a flat revenue history", () => {
    const flat = financials({ monthly_revenue: Array.from({ length: 12 }, () => 50_000) });

    expect(deriveFinancials(flat, CONTEXT).revenue_volatility).toBe(0);
  });

  it("rejects a revenue history of zeros as INVALID_FINANCIALS", () => {
    const zeros = financials({ monthly_revenue: [0, 0, 0, 0, 0, 0] });

    expect(() => deriveFinancials(zeros, CONTEXT)).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "INVALID_FINANCIALS" }),
    );
  });

  it("accepts a history with a single month above zero", () => {
    const sparse = financials({ monthly_revenue: [0, 0, 0, 0, 0, 600_000] });

    expect(deriveFinancials(sparse, CONTEXT).avg_revenue).toBe(100_000);
  });

  it("keeps a loss as a DSCR at or below zero", () => {
    const loss = deriveFinancials(financials({ monthly_opex: 120_000 }), CONTEXT);
    expect(loss.NOI_month).toBe(-20_000);
    expect(loss.operating_margin).toBe(-0.2);
    expect(loss.dscr).toBe(-2);

    const breakEven = deriveFinancials(financials({ monthly_opex: 100_000 }), CONTEXT);
    expect(breakEven.dscr).toBe(0);
  });

  it("gives a null DSCR when there is no debt to service", () => {
    const noDebt = deriveFinancials(financials({ existing_emi_total: 0 }), CONTEXT);

    expect(noDebt.debt_service_month).toBe(0);
    expect(noDebt.dscr).toBeNull();
  });

  it("gives a null cash buffer when there are no operating costs", () => {
    expect(deriveFinancials(financials({ monthly_opex: 0 }), CONTEXT).cash_buffer_days).toBeNull();
  });

  it("counts a business started this year as zero years old with one location", () => {
    const derived = deriveFinancials(financials(), {
      ...CONTEXT,
      yearStarted: 2026,
      additionalLocations: 0,
    });

    expect(derived.years_in_operation).toBe(0);
    expect(derived.num_locations).toBe(1);
  });
});
