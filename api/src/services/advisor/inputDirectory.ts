import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../errors/app-error.js";
import type { ImpactConditions } from "../input/classifier/schema.js";
import { placeFromPincode } from "../input/pincode.js";
import type { Financials } from "../input/schemas/financials.js";
import type { Contacts } from "../input/schemas/contacts.js";
import type { Consent } from "../input/schemas/consent.js";
import type { Operations } from "../input/schemas/operations.js";
import type { Profile } from "../input/schemas/profile.js";
import { SCORING_SNAPSHOT_ORDER } from "../input/store.js";
import type { BusinessDirectory } from "./directory.js";
import { annualRateFor } from "./tools/money.js";
import {
  HAZARDS,
  MONTHS,
  type BusinessRecord,
  type LoanRecord,
  type LoanStateName,
  type WeatherImpactEntry,
} from "./types.js";

// The advisor's view of a business in the input service's tables. Read only:
// the advisor never writes a business, a snapshot or a loan.
//
// How the input service's fields become the advisor's (NOTES.md):
// - Revenue: the scored snapshot's 6-12 months (the newest the bank
//   verified, or the newest while none is), the last one being the month
//   of `as_of`. A calendar month not given gets the average of those given.
// - Costs: the snapshot has one `monthly_opex` and no variable share, so it is
//   all fixed cost and variableCostShare is 0. A lost sale then saves nothing,
//   the cautious reading, and income matches the input service's NOI_month.
// - Other debt: `existing_emi_total`.
// - Loans: applied and authorised are PRE_LOAN, active is ACTIVE; closed and
//   rejected loans are left out. A loan entered without a rate gets the rate
//   its EMI implies. An active loan's disbursal date is the day it was last
//   changed, which is the day it was marked active.
// - Contacts: an owner address only for a channel they chose, and only when
//   they agreed to alerts (consent.alerts). No bank address: see below.

const ACTIVE_LOAN_STATES: Record<string, LoanStateName> = {
  applied: "PRE_LOAN",
  authorised: "PRE_LOAN",
  active: "ACTIVE",
};

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDate = (date: Date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const include = {
  locations: { where: { isPrimary: true }, take: 1 },
  // The snapshot scores use: the newest verified, or the newest while none is
  snapshots: { orderBy: [...SCORING_SNAPSHOT_ORDER], take: 1 },
  loans: { where: { status: { in: Object.keys(ACTIVE_LOAN_STATES) } }, orderBy: { createdAt: "asc" } },
  impactProfiles: { where: { status: { not: "pending" } }, orderBy: { version: "desc" }, take: 1 },
  suppliers: { orderBy: { position: "asc" } },
} satisfies Prisma.BusinessInclude;

type Row = Prisma.BusinessGetPayload<{ include: typeof include }>;

const noFinancials = (id: string) =>
  new AppError(
    `Business ${id} has no financial snapshot yet; the advisor needs one`,
    409,
    "NO_FINANCIALS",
  );

// Jan..Dec from up to 12 months, oldest first, ending in the month of asOf
export function revenueByCalendarMonth(monthly: number[], asOf: string): number[] {
  const last = Number(asOf.slice(5, 7)) - 1;
  const average = monthly.reduce((sum, value) => sum + value, 0) / Math.max(1, monthly.length);
  const byMonth: (number | undefined)[] = new Array<number | undefined>(12).fill(undefined);
  monthly.forEach((value, i) => {
    byMonth[(((last - (monthly.length - 1 - i)) % 12) + 12) % 12] = value;
  });
  return byMonth.map((value) => value ?? Math.round(average));
}

// The input classifier rates each hazard by how much it stops operations
// (physical) and how it moves demand. A loss on a hazard day is the share it
// stops plus any demand it takes away.
export function weatherImpactFrom(
  conditions: ImpactConditions,
): Partial<Record<(typeof HAZARDS)[number], WeatherImpactEntry>> {
  const impact: Partial<Record<(typeof HAZARDS)[number], WeatherImpactEntry>> = {};
  for (const hazard of HAZARDS) {
    const condition = conditions[hazard];
    const loss = Math.min(1, condition.physical + Math.max(0, -condition.demand));
    impact[hazard] =
      loss > 0
        ? { effect: "unfavourable", sensitivity: Math.round(loss * 100) / 100, reason: condition.reason }
        : condition.demand > 0
          ? { effect: "favourable", sensitivity: 0, reason: condition.reason }
          : { effect: "neutral", sensitivity: 0, reason: condition.reason };
  }
  return impact;
}

const rupees = (value: number) => `₹${Math.round(value).toLocaleString("en-IN")}`;

// Everything the owner entered on the form that the advisor has no field for,
// as plain sentences. They are the owner's claims, like any form fact.
function formFacts(row: Row, raw: Financials): Record<string, string> {
  const operations = row.operations as Partial<Operations>;
  const profile = row.profile as Partial<Profile>;
  const location = row.locations[0];
  const facts: Record<string, string> = {};
  if (operations.has_insurance !== undefined) {
    const covers = operations.insurance_covers ?? [];
    facts.insurance = operations.has_insurance
      ? `insured${covers.length > 0 ? ` for ${covers.join(", ")}` : ""}`
      : "no insurance";
  }
  if (operations.power_outage_hrs_month !== undefined) {
    const backup =
      operations.has_backup_power === undefined ? "" : operations.has_backup_power ? ", has backup power" : ", no backup power";
    facts.road_power_dependency = `about ${operations.power_outage_hrs_month} hours of power cuts a month${backup}`;
  }
  const seasonal = operations.seasonal_months ?? [];
  if (seasonal.length > 0) {
    facts.revenue_pattern = `seasonal, busiest in ${seasonal.map((month) => MONTHS[month - 1]).join(", ")}`;
  }
  if (operations.water_dependency) facts.water_dependency = operations.water_dependency;

  const premises = [location?.premises, location?.floor ? `${location.floor} floor` : null].filter(Boolean);
  if (premises.length > 0) facts.premises = premises.join(", ");
  if (profile.year_started !== undefined) facts.years_in_business = `started in ${profile.year_started}`;
  if (profile.employees !== undefined) facts.staff = `${profile.employees} employee${profile.employees === 1 ? "" : "s"}`;
  if (profile.products?.length) facts.products = profile.products.join(", ");
  if (profile.sales_channel) facts.sales_channel = profile.sales_channel.replace(/_/g, " ");

  if (row.suppliers.length > 0) {
    const named = row.suppliers.map(
      (supplier) => `${supplier.name} (${Math.round(supplier.share * 100)}%${supplier.critical ? ", critical" : ""})`,
    );
    facts.suppliers = `${row.suppliers.length} supplier${row.suppliers.length === 1 ? "" : "s"}: ${named.join(", ")}`;
  }

  const money = [
    `cash and bank balance ${rupees(raw.cash_balance)}`,
    `loans still owed ${rupees(raw.outstanding_debt)}`,
    `${raw.payment_delays_12m} late payment${raw.payment_delays_12m === 1 ? "" : "s"} in the last 12 months`,
  ];
  if (raw.receivables_days !== undefined) money.push(`customers pay in about ${raw.receivables_days} days`);
  facts.cash_and_debt = money.join("; ");
  return facts;
}

function loanRecord(loan: Row["loans"][number]): LoanRecord {
  const initialState = ACTIVE_LOAN_STATES[loan.status] ?? "PRE_LOAN";
  return {
    loanId: loan.id,
    principal: loan.amount,
    annualRatePct: loan.interestRate ?? annualRateFor(loan.amount, loan.emi, loan.tenureMonths),
    tenureMonths: loan.tenureMonths,
    disbursedOn: initialState === "ACTIVE" ? istDate(loan.updatedAt) : null,
    initialState,
  };
}

export function toBusinessRecord(row: Row): BusinessRecord {
  const snapshot = row.snapshots[0];
  if (!snapshot) throw noFinancials(row.id);
  const raw = snapshot.raw as Financials;
  const profile = row.profile as Partial<Profile>;
  const contacts = row.contacts as Partial<Contacts>;
  const consent = row.consent as Partial<Consent>;
  const channels = contacts.alerts?.channels ?? [];
  const location = row.locations[0];
  const place = placeFromPincode(location?.pincode);
  const conditions = row.impactProfiles[0]?.conditions as ImpactConditions | null | undefined;

  return {
    id: row.id,
    name: row.name,
    ownerName: contacts.owner?.name ?? "",
    sector: row.sector,
    description: profile.description ?? "",
    city: place.city ?? location?.address ?? "",
    state: place.state ?? "",
    lat: location?.lat ?? 0,
    lon: location?.lon ?? 0,
    contacts: {
      ownerEmail: channels.includes("email") ? (contacts.owner?.email ?? null) : null,
      ownerPhone: channels.includes("sms") ? (contacts.owner?.phone ?? null) : null,
      // Never contacts.bank_officer: the owner types it, so it could send the
      // bank's copy anywhere. The bank is reached through alert_contacts only.
      bankEmail: null,
      consent: consent.alerts === true,
    },
    finance: {
      monthlyRevenue: revenueByCalendarMonth(raw.monthly_revenue, raw.as_of),
      variableCostShare: 0,
      fixedMonthlyCosts: raw.monthly_opex,
      otherDebtMonthly: raw.existing_emi_total,
    },
    loans: row.loans.map(loanRecord),
    formFacts: formFacts(row, raw),
    ...(conditions ? { weatherImpact: weatherImpactFrom(conditions) } : {}),
    origin: "input",
  };
}

export function createInputDirectory(prisma: PrismaClient): BusinessDirectory {
  const read = async (id: string) => {
    const row = await prisma.business.findUnique({ where: { id }, include });
    return row ? toBusinessRecord(row) : null;
  };
  return {
    getBusiness: read,
    async findLoan(loanId) {
      const loan = await prisma.loan.findUnique({ where: { id: loanId }, select: { businessId: true } });
      if (!loan) return null;
      const business = await read(loan.businessId);
      const record = business?.loans.find((candidate) => candidate.loanId === loanId);
      return business && record ? { business, loan: record } : null;
    },
    // Businesses without a snapshot yet are left out: there is nothing to advise on
    async list() {
      const rows = await prisma.business.findMany({
        where: { snapshots: { some: {} } },
        include,
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => toBusinessRecord(row));
    },
  };
}
