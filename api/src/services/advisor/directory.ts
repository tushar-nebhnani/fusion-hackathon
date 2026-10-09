import { readFileSync } from "node:fs";
import { z } from "zod";
import { businessRecordSchema, type BusinessRecord, type LoanRecord } from "./types.js";

// Where the advisor looks up a business and its loans: the input service's
// tables (inputDirectory.ts), with the demo businesses of smes.json behind
// them outside production.
export interface BusinessDirectory {
  getBusiness(businessId: string): Promise<BusinessRecord | null>;
  findLoan(loanId: string): Promise<{ business: BusinessRecord; loan: LoanRecord } | null>;
  // Every business it knows; access is checked by the caller
  list(): Promise<BusinessRecord[]>;
}

const fileSchema = z.object({ businesses: z.array(businessRecordSchema) });

export function createDirectory(businesses: BusinessRecord[]): BusinessDirectory {
  const byId = new Map(businesses.map((business) => [business.id, business]));
  const loans = new Map(
    businesses.flatMap((business) =>
      business.loans.map((loan) => [loan.loanId, { business, loan }] as const),
    ),
  );
  return {
    getBusiness: (businessId) => Promise.resolve(byId.get(businessId) ?? null),
    findLoan: (loanId) => Promise.resolve(loans.get(loanId) ?? null),
    list: () => Promise.resolve([...byId.values()]),
  };
}

// Asks each directory in turn; the first that knows the id answers
export function combineDirectories(...directories: BusinessDirectory[]): BusinessDirectory {
  return {
    async getBusiness(businessId) {
      for (const directory of directories) {
        const business = await directory.getBusiness(businessId);
        if (business) return business;
      }
      return null;
    },
    async findLoan(loanId) {
      for (const directory of directories) {
        const found = await directory.findLoan(loanId);
        if (found) return found;
      }
      return null;
    },
    async list() {
      const lists = await Promise.all(directories.map((directory) => directory.list()));
      const seen = new Set<string>();
      return lists.flat().filter((business) => !seen.has(business.id) && Boolean(seen.add(business.id)));
    },
  };
}

// Reads smes.json once. A malformed file stops startup with the zod issue,
// since every advisor answer depends on it.
export function loadDirectory(path: string): BusinessDirectory {
  const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`advisor: ${path} is invalid at ${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""}`);
  }
  return createDirectory(parsed.data.businesses);
}
