import { z } from "zod";
import { consentSchema } from "./consent.js";
import { contactsSchema } from "./contacts.js";
import { locationsSchema } from "./locations.js";
import { operationsSchema } from "./operations.js";
import { profileSchema } from "./profile.js";
import { suppliersSchema } from "./suppliers.js";

export * from "./consent.js";
export * from "./contacts.js";
export * from "./financials.js";
export * from "./loan.js";
export * from "./locations.js";
export * from "./operations.js";
export * from "./profile.js";
export * from "./suppliers.js";

// POST /businesses: groups A to D, G and H
export const createBusinessSchema = z.strictObject({
  profile: profileSchema,
  locations: locationsSchema,
  operations: operationsSchema,
  suppliers: suppliersSchema,
  contacts: contactsSchema,
  consent: consentSchema,
});
export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

// PATCH /businesses/:id. Profile and operations fields are merged one by
// one; `owner`, `bank_officer` and `alerts` are each replaced whole.
export const patchBusinessSchema = z
  .strictObject({
    profile: profileSchema.partial().optional(),
    operations: operationsSchema.partial().optional(),
    contacts: contactsSchema.partial().optional(),
  })
  .refine((body) => Object.values(body).some((group) => group !== undefined), {
    message: "Send at least one of profile, operations or contacts",
  });

export const replaceSuppliersSchema = z.strictObject({ suppliers: suppliersSchema });
