import { describe, expect, it } from "vitest";
import { financeInputs } from "../testing/fixtures.js";
import { amortisedEmi, computeMetrics, repaymentRating } from "./compute.js";

describe("amortisedEmi", () => {
  it("matches the standard amortisation formula", () => {
    // 5,00,000 at 12% a year over 60 months
    expect(amortisedEmi(500_000, 12, 60)).toBeCloseTo(11_122.22, 2);
    expect(amortisedEmi(100_000, 10, 12)).toBeCloseTo(8_791.59, 2);
  });

  it("repays the principal exactly", () => {
    const emi = amortisedEmi(800_000, 13, 48);
    let balance = 800_000;
    for (let month = 0; month < 48; month++) balance = balance * (1 + 13 / 1200) - emi;
    expect(Math.abs(balance)).toBeLessThan(1);
  });

  it("splits the principal evenly at zero interest", () => {
    expect(amortisedEmi(120_000, 0, 12)).toBe(10_000);
  });

  it("is zero when there is nothing to repay", () => {
    expect(amortisedEmi(0, 12, 60)).toBe(0);
    expect(amortisedEmi(100_000, 12, 0)).toBe(0);
  });
});

describe("computeMetrics", () => {
  it("computes every metric of a healthy business", () => {
    expect(computeMetrics(financeInputs())).toEqual({
      months_of_history: 12,
      avg_monthly_revenue: 100_000,
      avg_monthly_expenses: 60_000,
      net_monthly_cashflow: 40_000,
      existing_emi: 20_000,
      proposed_emi: 0,
      total_emi: 20_000,
      dscr: 2,
      surplus_after_debt: 20_000,
      cash_reserves: 90_000,
      cash_runway: "positive_cashflow",
      cash_runway_months: null,
      // 90,000 against 80,000 of costs and repayments a month
      cash_buffer_months: 1.1,
      revenue_volatility: 0.1291,
      seasonality_index: 1.2,
      leverage: 0.2,
      repayment_record: { missed_payments_12m: 0, rating: "clean" },
      years_in_operation: 8,
    });
  });

  it("adds a requested loan to the EMI and to the leverage", () => {
    const metrics = computeMetrics(financeInputs({ proposed_emi: 20_000, proposed_principal: 360_000 }));

    expect(metrics.total_emi).toBe(40_000);
    expect(metrics.dscr).toBe(1);
    expect(metrics.surplus_after_debt).toBe(0);
    expect(metrics.leverage).toBe(0.5);
  });

  it("has no DSCR when there is no debt", () => {
    const metrics = computeMetrics(financeInputs({ existing_emi: 0, outstanding_debt: 0 }));

    expect(metrics.dscr).toBeNull();
    expect(metrics.leverage).toBe(0);
  });

  it("reports a runway while the business burns cash", () => {
    // 100,000 in, 95,000 + 20,000 out: 15,000 burnt a month from 90,000
    const metrics = computeMetrics(financeInputs({ monthly_expenses: 95_000 }));

    expect(metrics.cash_runway).toBe("burning");
    expect(metrics.cash_runway_months).toBe(6);
    expect(metrics.dscr).toBe(0.25);
  });

  it("gives a loss a DSCR below zero", () => {
    const metrics = computeMetrics(financeInputs({ monthly_expenses: 110_000 }));

    expect(metrics.net_monthly_cashflow).toBe(-10_000);
    expect(metrics.dscr).toBe(-0.5);
    expect(metrics.cash_runway_months).toBe(3);
  });

  it("has no volatility on flat revenue", () => {
    const metrics = computeMetrics(financeInputs({ monthly_revenue: Array<number>(6).fill(50_000) }));

    expect(metrics.months_of_history).toBe(6);
    expect(metrics.revenue_volatility).toBe(0);
    expect(metrics.seasonality_index).toBe(1);
  });

  it("captures a seasonal peak", () => {
    const months = [...Array<number>(11).fill(60_000), 180_000];

    expect(computeMetrics(financeInputs({ monthly_revenue: months })).seasonality_index).toBe(2.5714);
  });
});

describe("repaymentRating", () => {
  it.each([
    [0, "clean"],
    [1, "minor"],
    [2, "watch"],
    [3, "watch"],
    [4, "poor"],
  ])("rates %i missed payments as %s", (missed, rating) => {
    expect(repaymentRating(missed)).toBe(rating);
  });
});
