import { z } from "zod";

// D. Suppliers. That the shares sum to 1.0 is checked in validation.ts.

export const supplierSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  lat: z.number(),
  lon: z.number(),
  share: z.number().gt(0).max(1),
  critical: z.boolean().optional(),
});

export const suppliersSchema = z.array(supplierSchema).min(1).max(10);
export type Suppliers = z.infer<typeof suppliersSchema>;
