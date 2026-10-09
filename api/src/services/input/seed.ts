import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../../errors/app-error.js";
import { LOAN_STATUSES, type LoanStatus } from "./schemas/index.js";
import type { Actor, InputService } from "./service.js";
import { parseBody } from "./validation.js";

// smes.json loader. Each entry goes through the same service calls as a
// form submission, so seeded and entered businesses are validated, derived
// and stored the same way. They are marked `source: synthetic`.

// One entry of the seed file
export const seedEntrySchema = z.strictObject({
  // Stable id of the entry; a business that already has it is skipped
  external_id: z.string().trim().min(1).max(80),
  // Body of POST /businesses
  business: z.unknown(),
  // Body of POST /businesses/:id/snapshots
  snapshot: z.unknown().optional(),
  // Body of POST /businesses/:id/loans, plus the status the loan should reach
  loan: z.looseObject({ status: z.enum(LOAN_STATUSES).optional() }).optional(),
});

export interface SeedReport {
  total: number;
  created: number;
  skipped: number;
  failed: { index: number; external_id: string | null; code: string; message: string; details?: unknown }[];
}

export interface SeedOptions {
  // `defaults` gives every business its sector defaults without a model
  // call; `llm` classifies them one at a time
  classify: "defaults" | "llm";
}

// The statuses a new loan is walked through to reach each one
const STEPS: Record<LoanStatus, LoanStatus[]> = {
  applied: [],
  authorised: ["authorised"],
  active: ["authorised", "active"],
  closed: ["authorised", "active", "closed"],
  rejected: ["rejected"],
};

const SEED_ACTOR: Actor = { role: "bank", id: "seed" };

export async function loadSeedFile(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new AppError(`Seed file ${path} could not be read`, 404, "SEED_FILE_NOT_FOUND");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(`Seed file ${path} must be a JSON array of entries`, 422, "INVALID_SEED_FILE");
  }
  return parsed as unknown[];
}

function externalIdOf(entry: unknown): string | null {
  const id = typeof entry === "object" && entry !== null ? (entry as { external_id?: unknown }).external_id : null;
  return typeof id === "string" ? id : null;
}

// Entries are loaded one after another, which is also what keeps classifier
// calls from piling up. A bad entry is reported and left out whole; the
// rest still load.
export async function seedSmes(
  service: InputService,
  entries: unknown[],
  options: SeedOptions = { classify: "defaults" },
): Promise<SeedReport> {
  const report: SeedReport = { total: entries.length, created: 0, skipped: 0, failed: [] };

  for (const [index, raw] of entries.entries()) {
    let businessId: string | null = null;
    try {
      const entry = parseBody(seedEntrySchema, raw);
      if (await service.findBusinessIdByExternalId(entry.external_id)) {
        report.skipped += 1;
        continue;
      }
      const business = await service.createBusiness(entry.business, {
        source: "synthetic",
        externalId: entry.external_id,
        classifier: options.classify,
      });
      businessId = business.id;

      // The loan goes in before the snapshot, so the snapshot's debt service
      // counts a loan that is still only proposed
      if (entry.loan) {
        const { status = "applied", ...body } = entry.loan;
        const { loan } = await service.createLoan(businessId, body, SEED_ACTOR);
        for (const step of STEPS[status]) {
          await service.changeLoanStatus(loan.id, { status: step }, SEED_ACTOR);
        }
      }
      if (entry.snapshot !== undefined) await service.createSnapshot(businessId, entry.snapshot);
      report.created += 1;
    } catch (error) {
      if (businessId) await service.removeBusiness(businessId);
      if (!(error instanceof AppError)) throw error;
      report.failed.push({
        index,
        external_id: externalIdOf(raw),
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      });
    }
  }
  return report;
}
