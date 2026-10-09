import { z } from "zod";

// C. Operations

export const INSURANCE_COVERS = ["flood", "fire", "storm", "crop", "stock"] as const;

export const operationsSchema = z.strictObject({
  power_outage_hrs_month: z.number().int().min(0).max(720),
  has_backup_power: z.boolean().optional(),
  water_dependency: z.enum(["low", "medium", "high"]).optional(),
  has_insurance: z.boolean(),
  insurance_covers: z.array(z.enum(INSURANCE_COVERS)).max(INSURANCE_COVERS.length).optional(),
  seasonal_months: z.array(z.number().int().min(1).max(12)).max(12).optional(),
});
export type Operations = z.infer<typeof operationsSchema>;
