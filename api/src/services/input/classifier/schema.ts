import { z } from "zod";
import type { Hazard } from "../../climate/types.js";
import { INPUT } from "../config.js";
import { SECTORS } from "../schemas/profile.js";

export const MECHANISMS = [
  "demand_timing",
  "demand_mix",
  "foot_traffic",
  "substitution",
  "operational_downtime",
  "production_risk",
  "infrastructure_damage",
  "health_demand",
  "emergency_demand",
  "none",
] as const;
export type Mechanism = (typeof MECHANISMS)[number];

// One entry per climate hazard, under the climate unit's own names, so a
// profile lines up with a climate profile key for key
function perHazard<Schema extends z.ZodType>(schema: Schema) {
  return {
    river_flood: schema,
    flash_flood: schema,
    heat: schema,
    drought: schema,
    storm: schema,
    cold_wave: schema,
  } satisfies Record<Hazard, Schema>;
}

const condition = z.strictObject({
  // How much the condition stops the business operating. Always a risk.
  physical: z.number().min(0).max(1),
  // How it changes what customers buy: below zero demand drops, above it rises
  demand: z.number().min(-1).max(1),
  mechanism: z.enum(MECHANISMS),
  confidence: z.number().min(0).max(1),
  reason: z.string().trim().min(1).max(INPUT.classifier.reasonMaxChars),
});

// Guardrail 1: what a reply must satisfy before it is used
export const classifierOutputSchema = z.strictObject({
  category: z.enum(SECTORS),
  conditions: z.strictObject(perHazard(condition)),
  overall_confidence: z.number().min(0).max(1),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

// The shape the model is asked to fill. It carries no ranges: those are
// checked against `classifierOutputSchema`, so a bad value can be sent back
// to the model with the reason it was refused.
export const classifierWireSchema = z.object({
  category: z.enum(SECTORS),
  conditions: z.object(
    perHazard(
      z.object({
        physical: z.number(),
        demand: z.number(),
        mechanism: z.enum(MECHANISMS),
        confidence: z.number(),
        reason: z.string(),
      }),
    ),
  ),
  overall_confidence: z.number(),
});

// A stored condition also says where its values came from
const impactCondition = condition.extend({
  source: z.enum(["llm", "sector_default", "override"]),
});
export type ImpactCondition = z.infer<typeof impactCondition>;
export const impactConditionsSchema = z.strictObject(perHazard(impactCondition));
export type ImpactConditions = z.infer<typeof impactConditionsSchema>;

// PUT /businesses/:id/impact-profile: the bank changes any value and says why
export const overrideSchema = z
  .strictObject({
    reason: z.string().trim().min(5).max(300),
    category: z.enum(SECTORS).optional(),
    conditions: z.strictObject(perHazard(condition.partial())).partial().optional(),
  })
  .refine(
    (body) =>
      body.category !== undefined ||
      Object.values(body.conditions ?? {}).some((change) => Object.keys(change).length > 0),
    { message: "Send a category or at least one condition value to change" },
  );
