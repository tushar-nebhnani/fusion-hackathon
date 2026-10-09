import { z } from "zod";

// E. Financials: the raw numbers the owner enters. The ratios are computed
// in derive.ts. `verified_by_bank` is not accepted here; only the verify
// route sets it.

// Whole rupees
const inr = z.number().int().min(0).max(1e13);

export const financialsSchema = z.strictObject({
  as_of: z.iso.date(),
  // Oldest month first
  monthly_revenue: z.array(inr).min(6).max(12),
  monthly_opex: inr,
  existing_emi_total: inr,
  outstanding_debt: inr,
  cash_balance: inr,
  payment_delays_12m: z.number().int().min(0).max(24),
  receivables_days: z.number().int().min(0).max(365).optional(),
});
export type Financials = z.infer<typeof financialsSchema>;
