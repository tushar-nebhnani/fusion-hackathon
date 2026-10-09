import { HAZARDS, type Hazard } from "../../climate/types.js";
import type { ImpactConditions, Mechanism } from "../../input/classifier/schema.js";
import { FINANCE } from "../config.js";
import { round } from "../metrics/compute.js";

// How one hazard moves this business's revenue, read from the input
// service's weather-impact profile. The classifier there produces the
// values; this file only restates them as a direction and a size. It is an
// input to the stress test and never a score.

export const CHANNELS = ["revenue", "inventory", "operations", "assets", "supply_chain"] as const;
export type Channel = (typeof CHANNELS)[number];
export type Direction = "unfavourable" | "favourable" | "neutral";
// `llm` and `fallback` are the classifier's own outcomes; `override` is a
// bank officer's edit of the profile
export type SensitivitySource = "llm" | "fallback" | "override";

export interface HazardSensitivity {
  direction: Direction;
  // Share of monthly revenue lost, or gained, under a severe event (0 to 1)
  magnitude: number;
  channels: Channel[];
  reason: string;
  // The two values `magnitude` was worked out from
  physical: number;
  demand: number;
}

export type HazardSensitivities = Record<Hazard, HazardSensitivity>;

const CHANNELS_BY_MECHANISM: Record<Mechanism, Channel[]> = {
  demand_timing: ["revenue"],
  demand_mix: ["revenue"],
  foot_traffic: ["revenue"],
  substitution: ["revenue"],
  health_demand: ["revenue"],
  emergency_demand: ["revenue"],
  operational_downtime: ["operations", "revenue"],
  production_risk: ["inventory", "supply_chain"],
  infrastructure_damage: ["assets", "operations"],
  none: [],
};

// `physical` stops a share of the business from operating; `demand` scales
// what the rest of it sells. Below zero is revenue lost.
export function revenueEffect(physical: number, demand: number): number {
  return (1 - physical) * (1 + demand) - 1;
}

export function toSensitivities(conditions: ImpactConditions): HazardSensitivities {
  const hazards = {} as HazardSensitivities;
  for (const hazard of HAZARDS) {
    const { physical, demand, mechanism, reason } = conditions[hazard];
    const effect = revenueEffect(physical, demand);
    const neutral = Math.abs(effect) < FINANCE.stress.neutralBelow;
    hazards[hazard] = {
      direction: neutral ? "neutral" : effect < 0 ? "unfavourable" : "favourable",
      // A neutral hazard carries no magnitude, and none is above 1
      magnitude: neutral ? 0 : round(Math.min(1, Math.abs(effect)), 4),
      channels: neutral ? [] : CHANNELS_BY_MECHANISM[mechanism],
      reason,
      physical,
      demand,
    };
  }
  return hazards;
}
