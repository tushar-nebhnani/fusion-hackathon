import { describe, expect, it } from "vitest";
import { recomputeCashflow, type Cashflow } from "../tools/cashflow.js";
import { balanceAfter, daysInMonth, dscrFlag, emi, monthKey, outstanding } from "../tools/money.js";
import { amortise, generateRepaymentOptions } from "../tools/repayment.js";
import { simulateScenario } from "../tools/scenario.js";

const finance = {
  // A flat ₹1,80,000 a month keeps the expected values easy to check by hand
  monthlyRevenue: Array<number>(12).fill(180_000),
  variableCostShare: 0.75,
  fixedMonthlyCosts: 20_000,
  otherDebtMonthly: 3_000,
};

describe("money", () => {
  it("computes EMI against a known value", () => {
    // ₹1,00,000 at 12% for 12 months is ₹8,884.88 in every standard EMI table
    expect(emi(100_000, 12, 12)).toBeCloseTo(8884.88, 2);
    expect(emi(120_000, 0, 12)).toBe(10_000);
  });

  it("knows month lengths, including leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 8)).toBe(31);
  });

  it("flags DSCR below 1.2 and treats below 1.0 as critical", () => {
    expect(dscrFlag(1.25)).toBe("ok");
    expect(dscrFlag(1.1)).toBe("watch");
    expect(dscrFlag(0.95)).toBe("critical");
    expect(dscrFlag(null)).toBe("ok");
  });

  it("finds the outstanding balance after the EMIs paid so far", () => {
    const terms = { principal: 100_000, annualRatePct: 12, tenureMonths: 12 };
    const loan = outstanding(terms, "2026-01-05", "2026-07-20");
    expect(loan.paidMonths).toBe(6);
    expect(loan.remainingMonths).toBe(6);
    expect(loan.balance).toBeCloseTo(balanceAfter(100_000, 12, emi(100_000, 12, 12), 6), 6);
  });
});

describe("simulateScenario", () => {
  const loan = { principal: 300_000, annualRatePct: 14, tenureMonths: 24, source: "test" };
  const run = (principal = loan.principal) =>
    simulateScenario({
      finance,
      hazard: "river_flood",
      durationDays: 7,
      month: 8,
      year: 2026,
      sensitivity: 0.8,
      sensitivitySource: "weather_impact",
      loan: { ...loan, principal },
    });
  const result = run();

  it("applies daily revenue × closure days × sensitivity", () => {
    // 180000 / 31 × 7 × 0.8
    expect(result.revenueLoss).toBe(32_516);
    expect(result.incomeLoss).toBe(8_129);
    expect(result.normalNetOperatingIncome).toBe(25_000);
    expect(result.stressedNetOperatingIncome).toBe(16_871);
  });

  it("computes DSCR against EMI plus other debt", () => {
    expect(result.loan.emi).toBe(14_404);
    expect(result.debtService).toBe(17_404);
    expect(result.dscrNormal).toBe(1.44);
    expect(result.dscrStressed).toBe(0.97);
    expect(result.dscrFlag).toBe("critical");
  });

  it("finds the largest principal the stressed month can carry", () => {
    expect(run(result.maxPrincipalStressDscr1).dscrStressed).toBe(1);
    expect(run(result.maxPrincipalNormalDscr12).lowestNormalDscr).toBe(1.2);
  });
});

describe("recomputeCashflow", () => {
  const cashflow = recomputeCashflow(finance, {
    daysClosed: 6,
    stockLossInr: 40_000,
    equipmentDamageInr: 0,
    expectedReopenDate: "2026-08-12",
    reportedOn: "2026-08-12",
    insuranceClaim: { status: "none" },
  });

  it("projects 12 months from the month the closure started", () => {
    expect(cashflow.months).toHaveLength(12);
    expect(cashflow.months[0]?.month).toBe("2026-08");
    expect(cashflow.months[11]?.month).toBe("2027-07");
    expect(cashflow.closure).toEqual({ start: "2026-08-06", reopen: "2026-08-12", totalDays: 6 });
  });

  it("loses the closed days' income, and the stock in the reopening month", () => {
    const august = cashflow.months[0];
    expect(august?.closedDays).toBe(6);
    expect(august?.revenueLoss).toBe(34_839);
    expect(august?.directLoss).toBe(40_000);
    expect(august?.netOperatingIncome).toBe(25_000 - 8_710 - 40_000);
    expect(cashflow.months[1]?.netOperatingIncome).toBe(25_000);
  });

  it("spreads a closure across a month boundary", () => {
    const split = recomputeCashflow(finance, {
      daysClosed: 3,
      stockLossInr: 0,
      equipmentDamageInr: 0,
      expectedReopenDate: "2026-09-04",
      reportedOn: "2026-09-01",
    });
    expect(split.months[0]).toMatchObject({ month: "2026-08", closedDays: 3 });
    expect(split.months[1]).toMatchObject({ month: "2026-09", closedDays: 3 });
  });
});

describe("generateRepaymentOptions", () => {
  // Two weak months, then normal ones
  const cashflow: Cashflow = {
    closure: { start: "2026-08-01", reopen: "2026-08-31", totalDays: 30 },
    months: Array.from({ length: 12 }, (_, i) => ({
      month: monthKey("2026-08-01", i),
      revenue: 180_000,
      closedDays: 0,
      revenueLoss: 0,
      incomeLoss: 0,
      directLoss: 0,
      insuranceInflow: 0,
      netOperatingIncome: i < 2 ? 5_000 : 25_000,
    })),
    totals: { revenueLoss: 0, incomeLoss: 0, directLoss: 0, insuranceInflow: 0 },
  };
  const loan = { balance: 100_000, emi: emi(100_000, 12, 12), remainingMonths: 12, paidMonths: 0, annualRatePct: 12 };
  const result = generateRepaymentOptions({ loan, cashflow, otherDebtMonthly: 0 });
  const option = (kind: string) => result.options.find((o) => o.kind === kind);

  it("capitalises moratorium interest into the principal", () => {
    const moratorium = option("moratorium");
    expect(moratorium?.reliefMonths).toBe(2);
    // ₹1,00,000 × 1.01² after two months with nothing paid
    expect(moratorium?.schedule[1]?.balance).toBe(102_010);
    expect(moratorium?.schedule.slice(0, 2).every((row) => row.payment === 0)).toBe(true);
    expect(moratorium?.newEmi).toBe(Math.round(emi(102_010, 12, 12)));
    expect(moratorium?.months).toBe(14);
  });

  it("closes the step-down plan on the original date", () => {
    const step = option("step_down_up");
    expect(step?.months).toBe(12);
    expect(step?.endMonth).toBe(result.original.endMonth);
    expect(step?.schedule.at(-1)?.balance).toBe(0);
    expect(step?.reliefEmi).toBe(Math.round(loan.emi / 2));
    expect(step?.newEmi).toBeGreaterThan(Math.round(loan.emi));
  });

  it("lowers the EMI with a longer tenure, at a higher total cost", () => {
    const extension = option("tenure_extension");
    expect(extension?.months).toBe(24);
    expect(extension?.newEmi).toBeLessThan(result.original.newEmi);
    expect(extension?.extraCostVsOriginal).toBeGreaterThan(0);
  });

  it("offers the insurance bridge only with a dated claim", () => {
    expect(option("insurance_bridge")).toBeUndefined();
    const bridged = generateRepaymentOptions({
      loan,
      cashflow,
      otherDebtMonthly: 0,
      insuranceClaim: { status: "filed", expectedAmountInr: 40_000, expectedDate: "2026-10-15" },
    });
    const bridge = bridged.options.find((o) => o.kind === "insurance_bridge");
    expect(bridge?.prepayment).toBe(20_000);
    expect(bridge?.schedule[2]?.payment).toBe(20_000);
    expect(bridge?.schedule.at(-1)?.balance).toBe(0);
    expect(bridge?.endMonth).toBe(result.original.endMonth);
  });

  it("relieves the weakest month compared with the original schedule", () => {
    expect(result.original.minMonthlyDSCR).toBeLessThan(1);
    expect(option("moratorium")?.minMonthlyDSCR ?? 0).toBeGreaterThan(result.original.minMonthlyDSCR ?? 0);
  });

  it("closes every schedule at zero", () => {
    for (const o of result.options) expect(o.schedule.at(-1)?.balance).toBe(0);
    expect(amortise(1000, 0, "2026-01", { payment: () => 100, months: 10 }).at(-1)?.balance).toBe(0);
  });
});
