import { z } from "zod";

// B. Locations. Only the type of lat/lon is checked here; their range and
// coverage go through the climate unit's validator in validation.ts.

const PINCODE = /^[1-9]\d{5}$/;
const pincode = z.string().regex(PINCODE, "Expected a 6-digit PIN code");
const address = z.string().trim().min(1).max(250);

export const primaryLocationSchema = z.strictObject({
  lat: z.number(),
  lon: z.number(),
  address,
  pincode,
  premises: z.enum(["owned", "rented"]).optional(),
  floor: z.enum(["basement", "ground", "upper"]).optional(),
});

export const additionalLocationSchema = z.strictObject({
  lat: z.number(),
  lon: z.number(),
  address,
  pincode: pincode.optional(),
});

export const locationsSchema = z.strictObject({
  primary: primaryLocationSchema,
  additional_locations: z.array(additionalLocationSchema).max(5).default([]),
});
export type Locations = z.infer<typeof locationsSchema>;
