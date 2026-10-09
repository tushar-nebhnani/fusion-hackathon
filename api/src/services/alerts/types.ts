import { z } from "zod";

export const SEVERITIES = ["WATCH", "WARNING", "CRITICAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

// The climate pipeline's six hazards, plus a generic "flood" for producers
// that do not tell river and flash floods apart
export const HAZARDS = [
  "flood",
  "river_flood",
  "flash_flood",
  "heat",
  "drought",
  "storm",
  "cold_wave",
] as const;
export type Hazard = (typeof HAZARDS)[number];

export type Audience = "owner" | "bank";
// Email is the only channel. SMS was removed; see RESOLVE_LATER.md
export type Channel = "email";

export const LANGUAGES = ["en", "hi", "mr"] as const;
export type Language = (typeof LANGUAGES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const alertEventSchema = z.object({
  businessId: z.string().min(1).max(64),
  hazard: z.enum(HAZARDS),
  severity: z.enum(SEVERITIES),
  windowStart: isoDate,
  windowEnd: isoDate,
  evidence: z.string().min(1).max(500),
  sourceRunId: z.string().min(1).max(100),
});

// What the background monitor hands over when it detects a sudden change
export type AlertEvent = z.infer<typeof alertEventSchema>;

export const dedupeKey = (event: AlertEvent): string =>
  `${event.businessId}:${event.hazard}:${event.severity}:${event.windowStart}`;
