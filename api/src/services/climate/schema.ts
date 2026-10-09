import { z } from "zod";
import { HAZARDS } from "./types.js";

const unit = z.number().min(0).max(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const relevance = z.enum(["primary", "secondary", "dormant"]);

// README section 12. Every response is checked against this before it leaves.
export const climateProfileSchema = z.strictObject({
  location: z.strictObject({
    lat: z.number(),
    lon: z.number(),
    cells: z.strictObject({
      historical: z.string(),
      climate: z.string(),
      flood: z.string(),
      forecast: z.string(),
    }),
  }),
  overall_climate_risk: unit,
  grade: z.enum(["A", "B", "C", "D", "E"]),
  confidence: z.enum(["low", "med", "high"]),
  hazards: z
    .array(
      z.strictObject({
        hazard: z.enum(HAZARDS),
        relevance,
        relevance_method: z.enum(["static", "agent_raised"]),
        // Set when a dormant hazard was temporarily raised by the tripwire
        tripwire_promoted: z.literal(true).optional(),
        // Present when the agent, not the rule formula, set `components.forecast`
        forecast_source: z.literal("agent").optional(),
        forecast_note: z.string().optional(),
        score: unit,
        components: z.strictObject({
          structural: unit.optional(),
          historical: unit,
          forecast: unit,
        }),
        reason: z.string(),
      }),
    )
    .length(HAZARDS.length),
  active_events: z.array(
    z.strictObject({
      hazard: z.enum(HAZARDS),
      severity: z.enum(["watch", "warning", "severe"]),
      window_start: isoDate,
      window_end: isoDate,
      confidence: unit,
    }),
  ),
  data_freshness: z.strictObject({
    forecast_issued_at: z.string().nullable(),
    history_until: isoDate.nullable(),
  }),
  cache: z.enum(["complete_hit", "partial_hit", "miss"]),
  warnings: z.array(z.string()),
});

export type ClimateProfile = z.infer<typeof climateProfileSchema>;

// Shapes of the Redis entries. Anything that does not match is a cache miss.
export const cachedLayerSchema = z.object({
  payload: z.unknown(),
  fetchedAt: z.coerce.date(),
  staleAfter: z.coerce.date(),
  responseId: z.number().int().nullable(),
});

export const cachedRelevanceSchema = z
  .array(
    z.object({
      cellId: z.string(),
      hazard: z.string(),
      relevance,
      method: z.enum(["static", "agent_raised"]),
      indicatorValue: z.number().nullable(),
      indicators: z.unknown(),
      rationale: z.string().nullable(),
      confidence: z.enum(["low", "med", "high"]),
      agentVersion: z.string().nullable(),
      decidedAt: z.coerce.date(),
      reviewAfter: z.coerce.date(),
    }),
  )
  .min(1);

export const cachedForecastScoresSchema = z.record(
  z.enum(HAZARDS),
  z.object({ score: unit, note: z.string() }),
);
