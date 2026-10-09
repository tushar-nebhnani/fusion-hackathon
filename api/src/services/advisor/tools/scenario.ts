import { MONTHS, type BusinessRecord, type Hazard } from "../types.js";
import {
  daysInMonth,
  dscr,
  dscrFlag,
  emi,
  principalFor,
  ratio,
  rupees,
  type DscrFlag,
  type LoanTerms,
} from "./money.js";

export interface ScenarioInput {
  finance: BusinessRecord["finance"];
  hazard: Hazard;
  durationDays: number;
  // 1-12
  month: number;
  year: number;
  sensitivity: number;
  // "weather_impact" when the classifier rated this hazard, otherwise the
  // conservative full loss used for an unknown impact
  sensitivitySource: "weather_impact" | "assumed_full_loss_unknown_impact";
  loan: LoanTerms & { source: string };
  extraCosts?: number;
}

export interface ScenarioResult {
  hazard: Hazard;
  month: string;
  year: number;
  durationDaysApplied: number;
  sensitivity: number;
  sensitivitySource: ScenarioInput["sensitivitySource"];
  monthlyRevenue: number;
  dailyRevenue: number;
  revenueLoss: number;
  revenueLossPct: number;
  // Revenue loss less the cost of goods that was not sold either
  incomeLoss: number;
  extraCosts: number;
  normalNetOperatingIncome: number;
  stressedNetOperatingIncome: number;
  loan: LoanTerms & { emi: number; source: string };
  otherDebtMonthly: number;
  debtService: number;
  dscrNormal: number | null;
  dscrStressed: number | null;
  dscrFlag: DscrFlag;
  emiCoverageStressed: number | null;
  // Weakest ordinary month of the year, with no hazard at all
  lowestNormalMonth: string;
  lowestNormalDscr: number | null;
  // Largest principal on the same rate and tenure that keeps the stressed
  // month at DSCR 1.0, and every ordinary month at DSCR 1.2
  maxPrincipalStressDscr1: number;
  maxPrincipalNormalDscr12: number;
}

export const netOperatingIncome = (finance: BusinessRecord["finance"], revenue: number) =>
  revenue * (1 - finance.variableCostShare) - finance.fixedMonthlyCosts;

// README §7: revenue loss = daily revenue × closure days × sensitivity
export function simulateScenario(input: ScenarioInput): ScenarioResult {
  const { finance, loan } = input;
  const index = input.month - 1;
  const monthlyRevenue = finance.monthlyRevenue[index] ?? 0;
  const days = daysInMonth(input.year, input.month);
  const durationDaysApplied = Math.min(input.durationDays, days);
  const dailyRevenue = monthlyRevenue / days;
  const revenueLoss = dailyRevenue * durationDaysApplied * input.sensitivity;
  const incomeLoss = revenueLoss * (1 - finance.variableCostShare);
  const extraCosts = input.extraCosts ?? 0;

  const normalNoi = netOperatingIncome(finance, monthlyRevenue);
  const stressedNoi = normalNoi - incomeLoss - extraCosts;
  const loanEmi = emi(loan.principal, loan.annualRatePct, loan.tenureMonths);
  const debtService = loanEmi + finance.otherDebtMonthly;

  const normalByMonth = finance.monthlyRevenue.map((revenue) => netOperatingIncome(finance, revenue));
  const lowestNoi = Math.min(...normalByMonth);
  const lowestIndex = normalByMonth.indexOf(lowestNoi);
  const stressed = dscr(stressedNoi, debtService);

  return {
    hazard: input.hazard,
    month: MONTHS[index] ?? String(input.month),
    year: input.year,
    durationDaysApplied,
    sensitivity: input.sensitivity,
    sensitivitySource: input.sensitivitySource,
    monthlyRevenue: rupees(monthlyRevenue),
    dailyRevenue: rupees(dailyRevenue),
    revenueLoss: rupees(revenueLoss),
    revenueLossPct: monthlyRevenue > 0 ? ratio((revenueLoss / monthlyRevenue) * 100) : 0,
    incomeLoss: rupees(incomeLoss),
    extraCosts: rupees(extraCosts),
    normalNetOperatingIncome: rupees(normalNoi),
    stressedNetOperatingIncome: rupees(stressedNoi),
    loan: { ...loan, emi: rupees(loanEmi) },
    otherDebtMonthly: rupees(finance.otherDebtMonthly),
    debtService: rupees(debtService),
    dscrNormal: dscr(normalNoi, debtService),
    dscrStressed: stressed,
    dscrFlag: dscrFlag(stressed),
    emiCoverageStressed: dscr(stressedNoi - finance.otherDebtMonthly, loanEmi),
    lowestNormalMonth: MONTHS[lowestIndex] ?? "",
    lowestNormalDscr: dscr(lowestNoi, debtService),
    maxPrincipalStressDscr1: rupees(
      principalFor(stressedNoi - finance.otherDebtMonthly, loan.annualRatePct, loan.tenureMonths),
    ),
    maxPrincipalNormalDscr12: rupees(
      principalFor(lowestNoi / 1.2 - finance.otherDebtMonthly, loan.annualRatePct, loan.tenureMonths),
    ),
  };
}
