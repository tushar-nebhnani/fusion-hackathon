import { HAZARDS } from "../../climate/types.js";
import { INPUT } from "../config.js";
import type { Sector } from "../schemas/profile.js";
import { defaultCondition, sectorPhysical } from "./defaults.js";
import type { ClassifierOutput, ImpactConditions } from "./schema.js";

// Guardrails 2 and 3, applied to a reply that already passed the schema.
// The rules set the limits and the model fills in the detail inside them,
// the same way the climate agent may raise a hazard but never lower it.
export function applyGuards(output: ClassifierOutput, sector: Sector): ImpactConditions {
  const { minConfidence, physicalFloorShare } = INPUT.classifier;
  const conditions = {} as ImpactConditions;

  for (const hazard of HAZARDS) {
    const proposed = output.conditions[hazard];
    if (proposed.confidence < minConfidence) {
      // The model is guessing, so the sector's row stands in for this condition
      conditions[hazard] = defaultCondition(sector, hazard, "the classifier was not confident");
      continue;
    }
    // The model cannot argue a physical risk away, e.g. declare a
    // ground-floor shop immune to floods
    const floor = sectorPhysical(sector, hazard) * physicalFloorShare;
    conditions[hazard] = {
      ...proposed,
      physical: Math.max(proposed.physical, floor),
      source: "llm",
    };
  }
  return conditions;
}
