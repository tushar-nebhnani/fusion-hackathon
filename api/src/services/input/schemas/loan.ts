import { z } from "zod";

// F. Loan, entered by the bank

export const LOAN_STATUSES = ["applied", "authorised", "active", "closed", "rejected"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

// Only forward, one step at a time. `closed` and `rejected` are final.
export const LOAN_TRANSITIONS: Record<LoanStatus, readonly LoanStatus[]> = {
  applied: ["authorised", "rejected"],
  authorised: ["active", "rejected"],
  active: ["closed"],
  closed: [],
  rejected: [],
};

// Loans in these states define the "active cells" the monitor watches
export const MONITORED_LOAN_STATUSES: readonly LoanStatus[] = ["authorised", "active"];
// Loans in these states are not being repaid yet, so their EMI is added to
// the debt service of a new snapshot
export const PROPOSED_LOAN_STATUSES: readonly LoanStatus[] = ["applied", "authorised"];

const rupees = z.number().int().gt(0).max(1e13);

export const loanSchema = z.strictObject({
  amount: rupees,
  emi: rupees,
  tenure_months: z.number().int().min(1).max(360),
  interest_rate: z.number().min(0).max(40).optional(),
  purpose: z.enum(["working_capital", "equipment", "expansion", "other"]).optional(),
});
export type LoanInput = z.infer<typeof loanSchema>;

export const loanStatusSchema = z.strictObject({ status: z.enum(LOAN_STATUSES) });
