import { readFileSync } from "node:fs";
import { z } from "zod";
import { businessRecordSchema, type BusinessRecord, type LoanRecord } from "./types.js";

// Where the advisor looks up a business and its loans. It stands in for the
// finance unit and the input service, which do not exist yet (NOTES.md).
export interface BusinessDirectory {
  getBusiness(businessId: string): BusinessRecord | null;
  findLoan(loanId: string): { business: BusinessRecord; loan: LoanRecord } | null;
  list(): BusinessRecord[];
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
    getBusiness: (businessId) => byId.get(businessId) ?? null,
    findLoan: (loanId) => loans.get(loanId) ?? null,
    list: () => [...byId.values()],
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
