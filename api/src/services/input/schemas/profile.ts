import { z } from "zod";

// A. Business profile

export const SECTORS = [
  "retail",
  "apparel_footwear",
  "food_beverage",
  "food_processing",
  "delivery_ecommerce",
  "agriculture",
  "construction",
  "manufacturing",
  "hospitality_tourism",
  "logistics",
  "entertainment_leisure",
  "healthcare_pharmacy",
  "home_improvement",
  "automotive",
  "other",
] as const;
export type Sector = (typeof SECTORS)[number];

export const SALES_CHANNELS = ["walk_in", "delivery", "both", "b2b"] as const;
export const INDOOR_OUTDOOR = ["indoor", "outdoor", "both"] as const;

const UDYAM = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
// State code, the 10-character PAN, entity number, "Z", check character
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const profileSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  sector: z.enum(SECTORS),
  sub_sector: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().min(30).max(500),
  products: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  sales_channel: z.enum(SALES_CHANNELS).optional(),
  indoor_outdoor: z.enum(INDOOR_OUTDOOR).optional(),
  // The upper bound is the current year, checked in validation.ts
  year_started: z.number().int().min(1950),
  employees: z.number().int().min(0).optional(),
  udyam_number: z.string().regex(UDYAM, "Expected the format UDYAM-XX-00-0000000").optional(),
  gstin: z.string().regex(GSTIN, "Expected a 15-character GSTIN").optional(),
});
export type Profile = z.infer<typeof profileSchema>;
