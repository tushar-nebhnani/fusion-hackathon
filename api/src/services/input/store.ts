import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { CacheKey, Classification } from "./classifier/index.js";
import type { ImpactConditions } from "./classifier/schema.js";
import { INPUT } from "./config.js";
import type { DerivedFinancials } from "./derive.js";
import {
  MONITORED_LOAN_STATUSES,
  PROPOSED_LOAN_STATUSES,
  type Consent,
  type Contacts,
  type Financials,
  type LoanInput,
  type LoanStatus,
  type Locations,
  type Operations,
  type Profile,
  type Suppliers,
} from "./schemas/index.js";

// Flow step 5. Every function takes the client or an open transaction, so
// the service decides what is saved together.
export type Db = PrismaClient | Prisma.TransactionClient;

const json = (value: unknown) => value as Prisma.InputJsonValue;
const iso = (date: Date) => date.toISOString();
// Optional fields are left out of a response, as they were left out of the form
const optional = <Key extends string, Value>(key: Key, value: Value | null) =>
  (value === null ? {} : { [key]: value }) as { [K in Key]?: Value };

// ---- Business ----

export interface BusinessView {
  id: string;
  source: string;
  external_id: string | null;
  profile: Profile;
  locations: Locations;
  operations: Operations;
  suppliers: Suppliers;
  contacts: Contacts;
  consent: Consent;
  created_at: string;
  updated_at: string;
}

function locationRows(locations: Locations) {
  const { primary } = locations;
  return [
    {
      isPrimary: true,
      position: 0,
      lat: primary.lat,
      lon: primary.lon,
      address: primary.address,
      pincode: primary.pincode,
      premises: primary.premises ?? null,
      floor: primary.floor ?? null,
    },
    ...locations.additional_locations.map((location, index) => ({
      isPrimary: false,
      position: index + 1,
      lat: location.lat,
      lon: location.lon,
      address: location.address,
      pincode: location.pincode ?? null,
      premises: null,
      floor: null,
    })),
  ];
}

function supplierRows(suppliers: Suppliers) {
  return suppliers.map((supplier, index) => ({
    position: index,
    name: supplier.name,
    lat: supplier.lat,
    lon: supplier.lon,
    share: supplier.share,
    critical: supplier.critical ?? false,
  }));
}

export async function insertBusiness(
  db: Db,
  data: {
    source: string;
    externalId: string | null;
    ownerUserId: string | null;
    profile: Profile;
    locations: Locations;
    operations: Operations;
    suppliers: Suppliers;
    contacts: Contacts;
    consent: Consent;
  },
): Promise<string> {
  const row = await db.business.create({
    data: {
      source: data.source,
      externalId: data.externalId,
      ownerUserId: data.ownerUserId,
      name: data.profile.name,
      sector: data.profile.sector,
      profile: json(data.profile),
      operations: json(data.operations),
      contacts: json(data.contacts),
      consent: json(data.consent),
      locations: { create: locationRows(data.locations) },
      suppliers: { create: supplierRows(data.suppliers) },
    },
    select: { id: true },
  });
  return row.id;
}

// Null when the business does not exist
export function businessOwner(db: Db, id: string): Promise<{ ownerUserId: string | null } | null> {
  return db.business.findUnique({ where: { id }, select: { ownerUserId: true } });
}

export async function getBusiness(db: Db, id: string): Promise<BusinessView | null> {
  const row = await db.business.findUnique({
    where: { id },
    include: {
      locations: { orderBy: { position: "asc" } },
      suppliers: { orderBy: { position: "asc" } },
    },
  });
  const primary = row?.locations.find((location) => location.isPrimary);
  if (!row || !primary) return null;

  return {
    id: row.id,
    source: row.source,
    external_id: row.externalId,
    // The JSON columns hold what the schemas validated on the way in
    profile: row.profile as Profile,
    locations: {
      primary: {
        lat: primary.lat,
        lon: primary.lon,
        address: primary.address,
        pincode: primary.pincode ?? "",
        ...optional("premises", primary.premises as Locations["primary"]["premises"] | null),
        ...optional("floor", primary.floor as Locations["primary"]["floor"] | null),
      },
      additional_locations: row.locations
        .filter((location) => !location.isPrimary)
        .map((location) => ({
          lat: location.lat,
          lon: location.lon,
          address: location.address,
          ...optional("pincode", location.pincode),
        })),
    },
    operations: row.operations as Operations,
    suppliers: row.suppliers.map((supplier) => ({
      name: supplier.name,
      lat: supplier.lat,
      lon: supplier.lon,
      share: supplier.share,
      critical: supplier.critical,
    })),
    contacts: row.contacts as Contacts,
    consent: row.consent as unknown as Consent,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

// Takes a row lock, so two saves to one business run one after the other.
// False when the business does not exist.
export async function lockBusiness(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM businesses WHERE id = ${id} FOR UPDATE`;
  return rows.length === 1;
}

export async function updateBusiness(
  db: Db,
  id: string,
  groups: { profile?: Profile; operations?: Operations; contacts?: Contacts },
): Promise<void> {
  await db.business.update({
    where: { id },
    data: {
      ...(groups.profile && {
        name: groups.profile.name,
        sector: groups.profile.sector,
        profile: json(groups.profile),
      }),
      ...(groups.operations && { operations: json(groups.operations) }),
      ...(groups.contacts && { contacts: json(groups.contacts) }),
    },
  });
}

export async function replaceLocations(db: Db, id: string, locations: Locations): Promise<void> {
  await db.businessLocation.deleteMany({ where: { businessId: id } });
  await db.businessLocation.createMany({
    data: locationRows(locations).map((row) => ({ ...row, businessId: id })),
  });
  await db.business.update({ where: { id }, data: { updatedAt: new Date() } });
}

export async function replaceSuppliers(db: Db, id: string, suppliers: Suppliers): Promise<void> {
  await db.businessSupplier.deleteMany({ where: { businessId: id } });
  await db.businessSupplier.createMany({
    data: supplierRows(suppliers).map((row) => ({ ...row, businessId: id })),
  });
  await db.business.update({ where: { id }, data: { updatedAt: new Date() } });
}

export async function findBusinessIdByExternalId(db: Db, externalId: string): Promise<string | null> {
  const row = await db.business.findUnique({ where: { externalId }, select: { id: true } });
  return row?.id ?? null;
}

export async function deleteBusiness(db: Db, id: string): Promise<void> {
  await db.business.deleteMany({ where: { id } });
}

// ---- Financial snapshots ----

export interface SnapshotView {
  version: number;
  as_of: string;
  raw: Financials;
  derived: DerivedFinancials;
  derivation_version: string;
  verified_by_bank: boolean;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

type SnapshotRow = Prisma.FinancialSnapshotGetPayload<object>;

function snapshotView(row: SnapshotRow): SnapshotView {
  return {
    version: row.version,
    as_of: iso(row.asOf).slice(0, 10),
    raw: row.raw as Financials,
    derived: row.derived as unknown as DerivedFinancials,
    derivation_version: row.derivationVersion,
    verified_by_bank: row.verifiedByBank,
    verified_by: row.verifiedBy,
    verified_at: row.verifiedAt ? iso(row.verifiedAt) : null,
    created_at: iso(row.createdAt),
  };
}

// Append only. The caller holds the business lock, so versions cannot collide.
export async function insertSnapshot(
  tx: Prisma.TransactionClient,
  businessId: string,
  raw: Financials,
  derived: DerivedFinancials,
): Promise<SnapshotView> {
  const last = await tx.financialSnapshot.aggregate({
    where: { businessId },
    _max: { version: true },
  });
  const row = await tx.financialSnapshot.create({
    data: {
      businessId,
      version: (last._max.version ?? 0) + 1,
      asOf: new Date(`${raw.as_of}T00:00:00Z`),
      raw: json(raw),
      derived: json(derived),
      derivationVersion: INPUT.derivationVersion,
    },
  });
  return snapshotView(row);
}

// Newest first
export async function listSnapshots(db: Db, businessId: string): Promise<SnapshotView[]> {
  const rows = await db.financialSnapshot.findMany({
    where: { businessId },
    orderBy: { version: "desc" },
  });
  return rows.map(snapshotView);
}

export async function latestSnapshot(db: Db, businessId: string): Promise<SnapshotView | null> {
  const row = await db.financialSnapshot.findFirst({
    where: { businessId },
    orderBy: { version: "desc" },
  });
  return row ? snapshotView(row) : null;
}

// Verifying marks the snapshot; the numbers in it stay as entered
export async function verifySnapshot(
  db: Db,
  businessId: string,
  version: number,
  verifiedBy: string,
  at: Date,
): Promise<SnapshotView | null> {
  const key = { businessId_version: { businessId, version } };
  const existing = await db.financialSnapshot.findUnique({ where: key });
  if (!existing) return null;
  if (existing.verifiedByBank) return snapshotView(existing);
  const row = await db.financialSnapshot.update({
    where: key,
    data: { verifiedByBank: true, verifiedBy, verifiedAt: at },
  });
  return snapshotView(row);
}

// ---- Loans ----

export interface LoanView {
  id: string;
  business_id: string;
  amount: number;
  emi: number;
  tenure_months: number;
  interest_rate: number | null;
  purpose: string | null;
  status: LoanStatus;
  created_at: string;
  updated_at: string;
}

type LoanRow = Prisma.LoanGetPayload<object>;

function loanView(row: LoanRow): LoanView {
  return {
    id: row.id,
    business_id: row.businessId,
    amount: row.amount,
    emi: row.emi,
    tenure_months: row.tenureMonths,
    interest_rate: row.interestRate,
    purpose: row.purpose,
    status: row.status as LoanStatus,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export async function insertLoan(db: Db, businessId: string, loan: LoanInput): Promise<LoanView> {
  const row = await db.loan.create({
    data: {
      businessId,
      amount: loan.amount,
      emi: loan.emi,
      tenureMonths: loan.tenure_months,
      interestRate: loan.interest_rate ?? null,
      purpose: loan.purpose ?? null,
    },
  });
  return loanView(row);
}

export async function getLoan(db: Db, id: string): Promise<LoanView | null> {
  const row = await db.loan.findUnique({ where: { id } });
  return row ? loanView(row) : null;
}

export async function listLoans(db: Db, businessId: string): Promise<LoanView[]> {
  const rows = await db.loan.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } });
  return rows.map(loanView);
}

// Moves a loan only if it is still in `from`, so of two requests racing to
// change one loan a single one wins
export async function moveLoan(db: Db, id: string, from: LoanStatus, to: LoanStatus): Promise<boolean> {
  const { count } = await db.loan.updateMany({ where: { id, status: from }, data: { status: to } });
  return count === 1;
}

export async function proposedLoanEmi(db: Db, businessId: string): Promise<number> {
  const sum = await db.loan.aggregate({
    where: { businessId, status: { in: [...PROPOSED_LOAN_STATUSES] } },
    _sum: { emi: true },
  });
  return sum._sum.emi ?? 0;
}

export async function hasMonitoredLoan(db: Db, businessId: string): Promise<boolean> {
  const count = await db.loan.count({
    where: { businessId, status: { in: [...MONITORED_LOAN_STATUSES] } },
  });
  return count > 0;
}

// Primary locations of businesses with an authorised or active loan: the
// "active cells" the background monitor is meant to watch
export async function activeLocations(
  db: Db,
): Promise<{ business_id: string; lat: number; lon: number }[]> {
  const rows = await db.businessLocation.findMany({
    where: {
      isPrimary: true,
      business: { loans: { some: { status: { in: [...MONITORED_LOAN_STATUSES] } } } },
    },
    select: { businessId: true, lat: true, lon: true },
    orderBy: { businessId: "asc" },
  });
  return rows.map((row) => ({ business_id: row.businessId, lat: row.lat, lon: row.lon }));
}

// ---- Weather-impact profiles ----

export type ImpactProfileStatus = "pending" | "ok" | "fallback" | "overridden";

export interface ImpactProfileView {
  business_id: string;
  version: number;
  status: ImpactProfileStatus;
  category: string | null;
  // null while the classifier is still running
  conditions: ImpactConditions | null;
  overall_confidence: number | null;
  model: string | null;
  prompt_version: string;
  inputs_hash: string;
  note: string | null;
  overridden_by: string | null;
  override_reason: string | null;
  created_at: string;
  updated_at: string;
}

type ProfileRow = Prisma.WeatherImpactProfileGetPayload<object>;

export function impactProfileView(row: ProfileRow): ImpactProfileView {
  return {
    business_id: row.businessId,
    version: row.version,
    status: row.status as ImpactProfileStatus,
    category: row.category,
    conditions: row.conditions as ImpactConditions | null,
    overall_confidence: row.overallConfidence,
    model: row.model,
    prompt_version: row.promptVersion,
    inputs_hash: row.inputsHash,
    note: row.note,
    overridden_by: row.overriddenBy,
    override_reason: row.overrideReason,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

// A new version. The caller holds the business lock.
export async function insertProfile(
  tx: Prisma.TransactionClient,
  businessId: string,
  data: {
    status: ImpactProfileStatus;
    inputsHash: string;
    category?: string;
    conditions?: ImpactConditions;
    overallConfidence?: number | null;
    model?: string | null;
    note?: string;
    overriddenBy?: string;
    overrideReason?: string;
  },
): Promise<ProfileRow> {
  const last = await tx.weatherImpactProfile.aggregate({
    where: { businessId },
    _max: { version: true },
  });
  return tx.weatherImpactProfile.create({
    data: {
      businessId,
      version: (last._max.version ?? 0) + 1,
      status: data.status,
      inputsHash: data.inputsHash,
      promptVersion: INPUT.classifier.promptVersion,
      category: data.category ?? null,
      ...(data.conditions && { conditions: json(data.conditions) }),
      overallConfidence: data.overallConfidence ?? null,
      model: data.model ?? null,
      note: data.note ?? null,
      overriddenBy: data.overriddenBy ?? null,
      overrideReason: data.overrideReason ?? null,
    },
  });
}

// Fills a pending row with the classifier's result
export async function resolveProfile(db: Db, id: number, result: Classification): Promise<void> {
  await db.weatherImpactProfile.updateMany({
    where: { id, status: "pending" },
    data: {
      status: result.status,
      category: result.category,
      conditions: json(result.conditions),
      overallConfidence: result.overall_confidence,
      model: result.model,
      promptVersion: result.prompt_version,
      ...(result.raw_output && { rawOutput: json(result.raw_output) }),
      note: result.note,
    },
  });
}

export function latestProfile(db: Db, businessId: string): Promise<ProfileRow | null> {
  return db.weatherImpactProfile.findFirst({ where: { businessId }, orderBy: { version: "desc" } });
}

// The newest version that has values in it
export function latestResolvedProfile(db: Db, businessId: string): Promise<ProfileRow | null> {
  return db.weatherImpactProfile.findFirst({
    where: { businessId, status: { not: "pending" } },
    orderBy: { version: "desc" },
  });
}

export function pendingProfiles(db: Db, updatedBefore: Date): Promise<ProfileRow[]> {
  return db.weatherImpactProfile.findMany({
    where: { status: "pending", updatedAt: { lt: updatedBefore } },
    orderBy: { id: "asc" },
  });
}

// Classifier cache: the raw reply of an earlier run with the same inputs,
// prompt and model, from any business
export async function cachedRawOutput(db: Db, key: CacheKey): Promise<unknown> {
  const row = await db.weatherImpactProfile.findFirst({
    where: {
      inputsHash: key.inputsHash,
      promptVersion: key.promptVersion,
      model: key.model,
      status: "ok",
    },
    orderBy: { id: "desc" },
    select: { rawOutput: true },
  });
  return row?.rawOutput ?? null;
}

// ---- Trigger jobs ----

export type JobKind = "climate_warm" | "finance_first_profile" | "finance_recompute";

export interface JobRow {
  id: number;
  businessId: string;
  kind: string;
  payload: unknown;
}

export async function addJob(db: Db, businessId: string, kind: JobKind, payload: object): Promise<void> {
  await db.inputTriggerJob.create({ data: { businessId, kind, payload: json(payload) } });
}

// A newer job of the same kind replaces the ones still waiting
export async function dropPendingJobs(db: Db, businessId: string, kind: JobKind): Promise<void> {
  await db.inputTriggerJob.deleteMany({ where: { businessId, kind, status: "pending" } });
}

export function pendingJobs(db: Db, businessId?: string): Promise<JobRow[]> {
  return db.inputTriggerJob.findMany({
    where: { status: "pending", ...(businessId && { businessId }) },
    orderBy: { id: "asc" },
    select: { id: true, businessId: true, kind: true, payload: true },
  });
}

export function countPendingJobs(db: Db, businessId: string): Promise<number> {
  return db.inputTriggerJob.count({ where: { businessId, status: "pending" } });
}

export async function finishJob(db: Db, id: number): Promise<void> {
  await db.inputTriggerJob.updateMany({
    where: { id },
    data: { status: "done", attempts: { increment: 1 }, lastError: null },
  });
}

export async function failJob(db: Db, id: number, error: string): Promise<void> {
  await db.inputTriggerJob.updateMany({
    where: { id },
    data: { attempts: { increment: 1 }, lastError: error.slice(0, 500) },
  });
}

// ---- Request log (flow step 7) ----

export interface RequestLogEntry {
  method: string;
  route: string;
  status: number;
  latencyMs: number;
  businessId: string | null;
  actorRole: string | null;
}

export async function logRequest(db: Db, entry: RequestLogEntry): Promise<void> {
  await db.inputRequestLog.create({ data: entry });
}
