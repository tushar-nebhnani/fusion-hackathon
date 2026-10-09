import { HAZARDS, type Hazard } from "../../climate/types.js";
import type { Sector } from "../schemas/profile.js";
import type { ImpactCondition, ImpactConditions, Mechanism } from "./schema.js";

// Sector default rows: what is assumed about a business when only its
// sector is known. They are the floor under the classifier (guard.ts) and
// the whole profile when it cannot run. Starting assumptions, to be tuned
// against outcomes.

type Row = readonly [physical: number, demand: number, mechanism: Mechanism];

const down: Mechanism = "operational_downtime";
const traffic: Mechanism = "foot_traffic";
const crop: Mechanism = "production_risk";

// prettier-ignore
const TABLE: Record<Sector, Record<Hazard, Row>> = {
  retail:                { river_flood: [0.6, -0.4, down], flash_flood: [0.4, -0.4, traffic], heat: [0.1, -0.1, traffic], drought: [0.05, 0, "none"], storm: [0.4, -0.3, traffic], cold_wave: [0.05, -0.1, traffic] },
  apparel_footwear:      { river_flood: [0.6, -0.4, down], flash_flood: [0.4, -0.4, traffic], heat: [0.1, 0.1, "demand_timing"], drought: [0.05, 0, "none"], storm: [0.4, -0.3, traffic], cold_wave: [0.05, 0.3, "demand_timing"] },
  food_beverage:         { river_flood: [0.6, -0.4, down], flash_flood: [0.4, -0.3, traffic], heat: [0.15, 0.3, "demand_mix"], drought: [0.15, -0.1, crop], storm: [0.4, -0.3, traffic], cold_wave: [0.05, 0.1, "demand_mix"] },
  food_processing:       { river_flood: [0.7, -0.1, down], flash_flood: [0.4, 0, down], heat: [0.3, 0, crop], drought: [0.5, 0, crop], storm: [0.4, 0, "infrastructure_damage"], cold_wave: [0.1, 0, "none"] },
  delivery_ecommerce:    { river_flood: [0.6, -0.1, down], flash_flood: [0.4, 0.4, "substitution"], heat: [0.2, 0.3, "substitution"], drought: [0.05, 0, "none"], storm: [0.5, 0.2, down], cold_wave: [0.1, 0.2, "substitution"] },
  agriculture:           { river_flood: [0.9, 0, crop], flash_flood: [0.7, 0, crop], heat: [0.6, 0, crop], drought: [0.9, 0, crop], storm: [0.7, 0, crop], cold_wave: [0.5, 0, crop] },
  construction:          { river_flood: [0.8, -0.1, down], flash_flood: [0.7, 0, down], heat: [0.5, 0, down], drought: [0.2, 0, crop], storm: [0.7, 0.1, down], cold_wave: [0.2, 0, down] },
  manufacturing:         { river_flood: [0.7, -0.1, down], flash_flood: [0.4, 0, down], heat: [0.25, 0, crop], drought: [0.3, 0, crop], storm: [0.4, 0, "infrastructure_damage"], cold_wave: [0.1, 0, "none"] },
  hospitality_tourism:   { river_flood: [0.7, -0.6, down], flash_flood: [0.4, -0.5, traffic], heat: [0.15, -0.3, "demand_timing"], drought: [0.2, -0.1, crop], storm: [0.5, -0.5, traffic], cold_wave: [0.1, -0.1, "demand_timing"] },
  logistics:             { river_flood: [0.8, 0, down], flash_flood: [0.6, 0, down], heat: [0.2, 0, down], drought: [0.05, 0, "none"], storm: [0.6, 0, down], cold_wave: [0.3, 0, down] },
  entertainment_leisure: { river_flood: [0.6, -0.5, down], flash_flood: [0.3, 0.1, "substitution"], heat: [0.1, 0.2, "substitution"], drought: [0.05, 0, "none"], storm: [0.4, -0.3, traffic], cold_wave: [0.05, 0, "none"] },
  healthcare_pharmacy:   { river_flood: [0.6, 0.2, "emergency_demand"], flash_flood: [0.3, 0.2, "health_demand"], heat: [0.05, 0.3, "health_demand"], drought: [0.05, 0.1, "health_demand"], storm: [0.3, 0.1, "emergency_demand"], cold_wave: [0.05, 0.3, "health_demand"] },
  home_improvement:      { river_flood: [0.6, 0.3, "emergency_demand"], flash_flood: [0.4, 0.1, "emergency_demand"], heat: [0.1, 0.2, "demand_mix"], drought: [0.05, 0, "none"], storm: [0.4, 0.4, "emergency_demand"], cold_wave: [0.05, 0.1, "demand_mix"] },
  automotive:            { river_flood: [0.7, 0.2, "emergency_demand"], flash_flood: [0.4, 0.1, traffic], heat: [0.1, 0.2, "demand_mix"], drought: [0.05, 0, "none"], storm: [0.4, 0.1, "emergency_demand"], cold_wave: [0.05, 0.1, "demand_mix"] },
  other:                 { river_flood: [0.6, -0.2, down], flash_flood: [0.4, -0.2, traffic], heat: [0.15, 0, "none"], drought: [0.1, 0, "none"], storm: [0.4, -0.2, traffic], cold_wave: [0.05, 0, "none"] },
};

// A sector row is a coarse prior, not a reading of this business
const DEFAULT_CONFIDENCE = 0.3;
const PHYSICAL_MECHANISMS: readonly Mechanism[] = [down, crop, "infrastructure_damage"];

export function sectorPhysical(sector: Sector, hazard: Hazard): number {
  return TABLE[sector][hazard][0];
}

// The sector's row for one hazard, with its usual demand effect
export function defaultCondition(sector: Sector, hazard: Hazard, why: string): ImpactCondition {
  const [physical, demand, mechanism] = TABLE[sector][hazard];
  return {
    physical,
    demand,
    mechanism,
    confidence: DEFAULT_CONFIDENCE,
    reason: `Sector default for ${sector}: ${why}`,
    source: "sector_default",
  };
}

// Guardrail 5: the whole profile when the classifier cannot be used. Demand
// is left at zero, because a demand effect is a claim about this particular
// business and nothing has read its description.
export function fallbackConditions(sector: Sector, why: string): ImpactConditions {
  const conditions = {} as ImpactConditions;
  for (const hazard of HAZARDS) {
    const row = defaultCondition(sector, hazard, why);
    conditions[hazard] = {
      ...row,
      demand: 0,
      mechanism: PHYSICAL_MECHANISMS.includes(row.mechanism) ? row.mechanism : "none",
    };
  }
  return conditions;
}
