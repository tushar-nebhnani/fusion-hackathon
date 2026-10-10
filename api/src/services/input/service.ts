import { AppError } from "../../errors/app-error.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { HAZARDS } from "../climate/types.js";
import { fallbackConditions } from "./classifier/defaults.js";
import {
  classifierInputs,
  classify,
  hashInputs,
  type ClassifierInputs,
  type ClassifierLlm,
} from "./classifier/index.js";
import { impactConditionsSchema, overrideSchema, type ImpactConditions } from "./classifier/schema.js";
import { INPUT } from "./config.js";
import { deriveFinancials } from "./derive.js";
import {
  bankOnly,
  businessNotFound,
  consentRequired,
  invalidStatusTransition,
  loanNotFound,
  lockedByLoan,
  ownerOnly,
  sharingLockedByLoan,
  snapshotNotFound,
  type FieldErrors,
} from "./errors.js";
import {
  LOAN_TRANSITIONS,
  createBusinessSchema,
  financialsSchema,
  loanSchema,
  loanStatusSchema,
  locationsSchema,
  patchBusinessSchema,
  replaceSuppliersSchema,
  type Sector,
} from "./schemas/index.js";
import { consentChangeSchema } from "./schemas/consent.js";
import * as store from "./store.js";
import { runJobs, type InputPorts } from "./triggers.js";
import {
  assertValid,
  checkContacts,
  checkFinancials,
  checkLoan,
  checkLocations,
  checkOperations,
  checkProfile,
  checkSuppliers,
  currentYear,
  parseBody,
} from "./validation.js";

// Who is calling: the signed-in user and the role their email gives them
export interface Actor {
  role: "owner" | "bank";
  id: string | null;
}

// `pending` while a call to the climate unit or the finance service is
// still owed for this business
export type Scoring = "ok" | "pending";

export interface BusinessDetail extends store.BusinessView {
  latest_snapshot: store.SnapshotView | null;
  // What scores are built from: the newest verified snapshot, or the newest
  // one while none is verified (store.scoringSnapshot)
  scoring_snapshot: store.SnapshotView | null;
  loans: store.LoanView[];
  impact_profile: store.ImpactProfileView | null;
  scoring: Scoring;
}

export interface CreateBusinessOptions {
  source?: "user" | "synthetic";
  externalId?: string;
  // The signed-in owner creating it. Without one only the bank can open it.
  ownerUserId?: string | null;
  // `defaults` stores the sector defaults without calling the model
  classifier?: "llm" | "defaults";
}

export interface InputServiceDeps {
  prisma: PrismaClient;
  // The climate unit and the finance service. Not connected by default.
  ports?: InputPorts;
  // The classifier's model. Without one every profile is a fallback.
  llm?: ClassifierLlm;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
  triggerTimeoutMs?: number;
}

export interface InputService {
  createBusiness(body: unknown, options?: CreateBusinessOptions): Promise<BusinessDetail>;
  // Rejects with BUSINESS_NOT_FOUND unless the business exists and the
  // actor is the owner who created it, or a bank officer it is shared with
  assertAccess(id: string, actor: Actor): Promise<void>;
  // The same rule for many businesses in one read: those of `ids` the actor may see
  visibleTo(ids: string[], actor: Actor): Promise<string[]>;
  getBusiness(id: string): Promise<BusinessDetail>;
  // The three below change what the risk is worked out from. Once a loan is
  // authorised or active they are the bank's to make (LOCKED_BY_LOAN);
  // an owner can still change contacts.
  patchBusiness(id: string, body: unknown, actor: Actor): Promise<BusinessDetail>;
  replaceLocations(id: string, body: unknown, actor: Actor): Promise<BusinessDetail>;
  replaceSuppliers(id: string, body: unknown, actor: Actor): Promise<BusinessDetail>;
  // The owner who created the business changes share_with_bank and alerts.
  // Withdrawing sharing hides the business from the bank at once, but not
  // while a loan is authorised or active (CONSENT_LOCKED_BY_LOAN).
  changeConsent(id: string, body: unknown, actor: Actor): Promise<BusinessDetail>;
  createSnapshot(id: string, body: unknown): Promise<{ snapshot: store.SnapshotView; scoring: Scoring }>;
  listSnapshots(id: string): Promise<store.SnapshotView[]>;
  verifySnapshot(id: string, version: string, actor: Actor): Promise<store.SnapshotView>;
  createLoan(id: string, body: unknown, actor: Actor): Promise<{ loan: store.LoanView; scoring: Scoring }>;
  changeLoanStatus(
    loanId: string,
    body: unknown,
    actor: Actor,
  ): Promise<{ loan: store.LoanView; scoring: Scoring }>;
  getImpactProfile(id: string): Promise<store.ImpactProfileView>;
  reclassify(id: string, actor: Actor): Promise<store.ImpactProfileView>;
  overrideImpactProfile(id: string, body: unknown, actor: Actor): Promise<store.ImpactProfileView>;
  // Primary locations of businesses with an authorised or active loan
  activeLocations(): Promise<{ business_id: string; lat: number; lon: number }[]>;
  // Runs again whatever is still owed: unfinished classifications and
  // trigger jobs that failed or had no service to go to
  retryPending(): Promise<{ profiles: number; jobs: number }>;
  logRequest(entry: store.RequestLogEntry): void;
  // Resolves once the work started in the background has finished
  idle(): Promise<void>;
  findBusinessIdByExternalId(externalId: string): Promise<string | null>;
  removeBusiness(id: string): Promise<void>;
}

interface ScheduledClassification {
  profileId: number;
  inputs: ClassifierInputs;
  useCache: boolean;
}

// A pending profile younger than this is still being classified by the
// request that created it, so a retry leaves it alone
const RETRY_PROFILE_AFTER_MS = 2 * 60_000;

// The bank sees what it entered itself and what the owner agreed to share
// (consent.share_with_bank); an owner sees the businesses they created
function maySee(business: { ownerUserId: string | null; sharedWithBank: boolean }, actor: Actor): boolean {
  return actor.role === "bank"
    ? business.ownerUserId === null || business.sharedWithBank
    : business.ownerUserId === actor.id;
}

function requireBank(actor: Actor): string {
  if (actor.role !== "bank" || !actor.id) throw bankOnly();
  return actor.id;
}

export function createInputService(deps: InputServiceDeps): InputService {
  const { prisma } = deps;
  const ports = deps.ports ?? {};
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const background = new Set<Promise<void>>();

  function inBackground(label: string, work: () => Promise<void>): void {
    const task: Promise<void> = work()
      .catch((error: unknown) => {
        logger.error(`input: ${label} failed`, error);
      })
      .finally(() => background.delete(task));
    background.add(task);
  }

  async function required(db: store.Db, id: string): Promise<store.BusinessView> {
    const business = await store.getBusiness(db, id);
    if (!business) throw businessNotFound(id);
    return business;
  }

  // Locks the business for the length of the transaction and loads it
  async function lockAndLoad(tx: Parameters<typeof store.lockBusiness>[0], id: string) {
    if (!(await store.lockBusiness(tx, id))) throw businessNotFound(id);
    return required(tx, id);
  }

  // Inside the save, after the business is locked: an owner cannot move
  // the premises or restate the business from under a loan the bank made
  async function assertUnlocked(
    tx: Parameters<typeof store.lockBusiness>[0],
    id: string,
    actor: Actor,
    what: string,
  ): Promise<void> {
    if (actor.role !== "bank" && (await store.hasMonitoredLoan(tx, id))) throw lockedByLoan(what);
  }

  async function scoringOf(id: string): Promise<Scoring> {
    return (await store.countPendingJobs(prisma, id)) > 0 ? "pending" : "ok";
  }

  // Flow step 6, climate and finance. Runs after the save has committed and
  // also retries anything this business was still owed.
  async function runTriggers(id: string): Promise<Scoring> {
    await runJobs(prisma, await store.pendingJobs(prisma, id), ports, {
      timeoutMs: deps.triggerTimeoutMs ?? INPUT.triggerTimeoutMs,
      logger,
    });
    return scoringOf(id);
  }

  // Flow step 6, classifier. Inside the save: when the fields the model
  // reads have changed since the last profile, a new pending version is
  // stored. The run itself starts once the save has committed.
  async function scheduleClassification(
    tx: Parameters<typeof store.insertProfile>[0],
    business: store.BusinessView,
    options: { force?: boolean; mode?: "llm" | "defaults" } = {},
  ): Promise<ScheduledClassification | null> {
    const inputs = classifierInputs(business);
    const inputsHash = hashInputs(inputs);
    const latest = await store.latestProfile(tx, business.id);
    if (!options.force && latest?.inputsHash === inputsHash) return null;

    if (options.mode === "defaults") {
      await store.insertProfile(tx, business.id, {
        status: "fallback",
        inputsHash,
        category: inputs.sector,
        conditions: fallbackConditions(inputs.sector, "the classifier was not run"),
        overallConfidence: 0,
        note: "stored with sector defaults; the classifier was not run",
      });
      return null;
    }
    const profile = await store.insertProfile(tx, business.id, { status: "pending", inputsHash });
    return { profileId: profile.id, inputs, useCache: !options.force };
  }

  async function finishClassification(scheduled: ScheduledClassification): Promise<void> {
    const result = await classify(scheduled.inputs, {
      llm: deps.llm,
      cached: scheduled.useCache ? (key) => store.cachedRawOutput(prisma, key) : undefined,
    });
    await store.resolveProfile(prisma, scheduled.profileId, result);
  }

  function startClassification(scheduled: ScheduledClassification | null): void {
    if (scheduled) inBackground("classification", () => finishClassification(scheduled));
  }

  async function detail(id: string, scoring?: Scoring): Promise<BusinessDetail> {
    const business = await required(prisma, id);
    const [snapshot, scored, loans, profile] = await Promise.all([
      store.latestSnapshot(prisma, id),
      store.scoringSnapshot(prisma, id),
      store.listLoans(prisma, id),
      store.latestProfile(prisma, id),
    ]);
    return {
      ...business,
      latest_snapshot: snapshot,
      scoring_snapshot: scored,
      loans,
      impact_profile: profile ? store.impactProfileView(profile) : null,
      scoring: scoring ?? (await scoringOf(id)),
    };
  }

  async function getImpactProfile(id: string): Promise<store.ImpactProfileView> {
    await required(prisma, id);
    const profile = await store.latestProfile(prisma, id);
    if (!profile) throw new AppError(`Business ${id} has no impact profile`, 404, "NOT_FOUND");
    return store.impactProfileView(profile);
  }

  return {
    async createBusiness(body, options = {}) {
      const input = parseBody(createBusinessSchema, body);
      if (!input.consent.data_processing) {
        throw consentRequired("consent.data_processing must be true; nothing is stored without it");
      }
      const at = now();
      const errors: FieldErrors = {};
      checkProfile(input.profile, at, errors);
      const locations = checkLocations(input.locations, errors);
      checkOperations(input.operations, errors);
      const suppliers = checkSuppliers(input.suppliers, errors);
      checkContacts(input.contacts, errors);
      assertValid(errors);

      const saved = await prisma.$transaction(async (tx) => {
        const id = await store.insertBusiness(tx, {
          source: options.source ?? "user",
          externalId: options.externalId ?? null,
          ownerUserId: options.ownerUserId ?? null,
          profile: input.profile,
          locations,
          operations: input.operations,
          suppliers,
          contacts: input.contacts,
          consent: { ...input.consent, timestamp: at.toISOString(), version: INPUT.consentVersion },
        });
        const scheduled = await scheduleClassification(tx, await required(tx, id), {
          mode: options.classifier,
        });
        const { lat, lon } = locations.primary;
        await store.addJob(tx, id, "climate_warm", { lat, lon });
        return { id, scheduled };
      });

      startClassification(saved.scheduled);
      return detail(saved.id, await runTriggers(saved.id));
    },

    async assertAccess(id, actor) {
      const business = await store.businessOwner(prisma, id);
      // Someone else's business looks the same as one that does not exist
      if (!business || !maySee(business, actor)) throw businessNotFound(id);
    },

    async visibleTo(ids, actor) {
      const owners = await store.businessOwners(prisma, ids);
      return owners.filter((business) => maySee(business, actor)).map((business) => business.id);
    },

    getBusiness(id) {
      return detail(id);
    },

    async patchBusiness(id, body, actor) {
      const patch = parseBody(patchBusinessSchema, body);
      const scheduled = await prisma.$transaction(async (tx) => {
        const current = await lockAndLoad(tx, id);
        if (patch.profile || patch.operations) await assertUnlocked(tx, id, actor, "profile or operations");
        const errors: FieldErrors = {};
        const next: Parameters<typeof store.updateBusiness>[2] = {};
        if (patch.profile) {
          next.profile = { ...current.profile, ...patch.profile };
          checkProfile(next.profile, now(), errors);
        }
        if (patch.operations) {
          next.operations = { ...current.operations, ...patch.operations };
          checkOperations(next.operations, errors);
        }
        if (patch.contacts) {
          next.contacts = { ...current.contacts, ...patch.contacts };
          checkContacts(next.contacts, errors);
        }
        assertValid(errors);
        await store.updateBusiness(tx, id, next);
        return scheduleClassification(tx, await required(tx, id));
      });

      startClassification(scheduled);
      return detail(id, await runTriggers(id));
    },

    async replaceLocations(id, body, actor) {
      const errors: FieldErrors = {};
      const locations = checkLocations(parseBody(locationsSchema, body), errors, "");
      assertValid(errors);

      const scheduled = await prisma.$transaction(async (tx) => {
        await lockAndLoad(tx, id);
        await assertUnlocked(tx, id, actor, "locations");
        await store.replaceLocations(tx, id, locations);
        const { lat, lon } = locations.primary;
        await store.dropPendingJobs(tx, id, "climate_warm");
        await store.addJob(tx, id, "climate_warm", { lat, lon });
        // The PIN code decides the city and state the classifier is given
        return scheduleClassification(tx, await required(tx, id));
      });

      startClassification(scheduled);
      return detail(id, await runTriggers(id));
    },

    async replaceSuppliers(id, body, actor) {
      const errors: FieldErrors = {};
      const suppliers = checkSuppliers(parseBody(replaceSuppliersSchema, body).suppliers, errors);
      assertValid(errors);

      await prisma.$transaction(async (tx) => {
        await lockAndLoad(tx, id);
        await assertUnlocked(tx, id, actor, "suppliers");
        await store.replaceSuppliers(tx, id, suppliers);
      });
      return detail(id, await runTriggers(id));
    },

    async changeConsent(id, body, actor) {
      const change = parseBody(consentChangeSchema, body);
      await prisma.$transaction(async (tx) => {
        const business = await lockAndLoad(tx, id);
        const owner = await store.businessOwner(tx, id);
        if (actor.role !== "owner" || !actor.id || owner?.ownerUserId !== actor.id) throw ownerOnly();
        if (change.share_with_bank === false && (await store.hasMonitoredLoan(tx, id))) {
          throw sharingLockedByLoan();
        }
        await store.updateBusiness(tx, id, {
          consent: {
            ...business.consent,
            ...change,
            // When the owner last gave or changed their consent, and under which wording
            timestamp: now().toISOString(),
            version: INPUT.consentVersion,
          },
        });
      });
      return detail(id);
    },

    async createSnapshot(id, body) {
      const raw = parseBody(financialsSchema, body);
      const at = now();
      const errors: FieldErrors = {};
      checkFinancials(raw, at, errors);
      assertValid(errors);

      const snapshot = await prisma.$transaction(async (tx) => {
        const business = await lockAndLoad(tx, id);
        const derived = deriveFinancials(raw, {
          yearStarted: business.profile.year_started,
          currentYear: currentYear(at),
          additionalLocations: business.locations.additional_locations.length,
          proposedLoanEmi: await store.proposedLoanEmi(tx, id),
        });
        const saved = await store.insertSnapshot(tx, id, raw, derived);
        // Rescored only while nothing is verified; after that, on verification
        const scored = await store.scoringSnapshot(tx, id);
        if (scored?.version === saved.version && (await store.hasMonitoredLoan(tx, id))) {
          await store.dropPendingJobs(tx, id, "finance_recompute");
          await store.addJob(tx, id, "finance_recompute", { snapshot_version: saved.version });
        }
        return saved;
      });
      return { snapshot, scoring: await runTriggers(id) };
    },

    async listSnapshots(id) {
      await required(prisma, id);
      return store.listSnapshots(prisma, id);
    },

    async verifySnapshot(id, version, actor) {
      const verifiedBy = requireBank(actor);
      await required(prisma, id);
      if (!/^[1-9]\d{0,8}$/.test(version)) throw snapshotNotFound(id, version);
      const result = await prisma.$transaction(async (tx) => {
        await lockAndLoad(tx, id);
        const verified = await store.verifySnapshot(tx, id, Number(version), verifiedBy, now());
        if (!verified) return null;
        // Newly verified and now what scores are built from: rescore a live loan
        const scored = await store.scoringSnapshot(tx, id);
        if (verified.changed && scored?.version === verified.snapshot.version && (await store.hasMonitoredLoan(tx, id))) {
          await store.dropPendingJobs(tx, id, "finance_recompute");
          await store.addJob(tx, id, "finance_recompute", { snapshot_version: verified.snapshot.version });
        }
        return verified;
      });
      if (!result) throw snapshotNotFound(id, version);
      if (result.changed) await runTriggers(id);
      return result.snapshot;
    },

    async createLoan(id, body, actor) {
      requireBank(actor);
      const input = parseBody(loanSchema, body);
      const business = await required(prisma, id);
      if (!business.consent.share_with_bank) {
        throw consentRequired("consent.share_with_bank must be true for the business to have a loan");
      }
      const errors: FieldErrors = {};
      checkLoan(input, errors);
      assertValid(errors);

      const loan = await store.insertLoan(prisma, id, input);
      return { loan, scoring: await scoringOf(id) };
    },

    async changeLoanStatus(loanId, body, actor) {
      requireBank(actor);
      const { status: to } = parseBody(loanStatusSchema, body);
      const loan = await store.getLoan(prisma, loanId);
      if (!loan) throw loanNotFound(loanId);
      const from = loan.status;
      const refuse = () => invalidStatusTransition(from, to, LOAN_TRANSITIONS[from]);
      if (!LOAN_TRANSITIONS[from].includes(to)) throw refuse();

      await prisma.$transaction(async (tx) => {
        // Lost to another request that moved the loan first
        if (!(await store.moveLoan(tx, loanId, from, to))) throw refuse();
        if (to === "authorised") {
          await store.addJob(tx, loan.business_id, "finance_first_profile", { loan_id: loanId });
        }
      });
      const scoring = await runTriggers(loan.business_id);
      return { loan: (await store.getLoan(prisma, loanId)) ?? loan, scoring };
    },

    getImpactProfile,

    async reclassify(id, actor) {
      requireBank(actor);
      const scheduled = await prisma.$transaction(async (tx) =>
        scheduleClassification(tx, await lockAndLoad(tx, id), { force: true }),
      );
      startClassification(scheduled);
      return getImpactProfile(id);
    },

    async overrideImpactProfile(id, body, actor) {
      const overriddenBy = requireBank(actor);
      const change = parseBody(overrideSchema, body);

      const profile = await prisma.$transaction(async (tx) => {
        const business = await lockAndLoad(tx, id);
        const sector: Sector = business.profile.sector;
        const base = await store.latestResolvedProfile(tx, id);
        const conditions = {
          ...((base?.conditions as ImpactConditions | null) ??
            fallbackConditions(sector, "no classifier result yet")),
        };
        for (const hazard of HAZARDS) {
          const values = change.conditions?.[hazard];
          if (values && Object.keys(values).length > 0) {
            conditions[hazard] = { ...conditions[hazard], ...values, source: "override" };
          }
        }
        return store.insertProfile(tx, id, {
          status: "overridden",
          // Recorded so the override stands until the business itself changes
          inputsHash: hashInputs(classifierInputs(business)),
          category: change.category ?? base?.category ?? sector,
          conditions: impactConditionsSchema.parse(conditions),
          overallConfidence: base?.overallConfidence ?? null,
          overriddenBy,
          overrideReason: change.reason,
        });
      });
      return store.impactProfileView(profile);
    },

    activeLocations() {
      return store.activeLocations(prisma);
    },

    async retryPending() {
      const stale = new Date(now().getTime() - RETRY_PROFILE_AFTER_MS);
      const profiles = await store.pendingProfiles(prisma, stale);
      for (const profile of profiles) {
        const business = await store.getBusiness(prisma, profile.businessId);
        if (!business) continue;
        await finishClassification({
          profileId: profile.id,
          inputs: classifierInputs(business),
          useCache: true,
        });
      }
      const jobs = await store.pendingJobs(prisma);
      await runJobs(prisma, jobs, ports, {
        timeoutMs: deps.triggerTimeoutMs ?? INPUT.triggerTimeoutMs,
        logger,
      });
      return { profiles: profiles.length, jobs: jobs.length };
    },

    logRequest(entry) {
      inBackground("request log", () => store.logRequest(prisma, entry));
    },

    async idle() {
      while (background.size > 0) await Promise.all(background);
    },

    findBusinessIdByExternalId(externalId) {
      return store.findBusinessIdByExternalId(prisma, externalId);
    },

    removeBusiness(id) {
      return store.deleteBusiness(prisma, id);
    },
  };
}
