import { z } from "zod";

// G. Contacts and alert preferences

const INDIAN_MOBILE = /^\+91\d{10}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const name = z.string().trim().min(1).max(120);
const time = z.string().regex(HH_MM, "Expected HH:MM");

export const contactsSchema = z.strictObject({
  owner: z.strictObject({
    name,
    phone: z.string().regex(INDIAN_MOBILE, "Expected +91 followed by 10 digits"),
    email: z.email().optional(),
    language: z.enum(["en", "hi", "mr"]).default("en"),
  }),
  bank_officer: z.strictObject({
    name,
    email: z.email(),
    phone: z.string().regex(E164, "Expected an E.164 number, e.g. +912212345678").optional(),
  }),
  alerts: z.strictObject({
    channels: z.array(z.enum(["sms", "email"])).min(1).max(2),
    // IST
    quiet_hours: z.strictObject({ start: time, end: time }).optional(),
  }),
});
export type Contacts = z.infer<typeof contactsSchema>;
