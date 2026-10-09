import type { Sector } from "../schemas/profile.js";

// The reference table given to the model: for each category, the weather
// that usually helps it, the weather that usually hurts it, and why.
// Changing it changes classifier output, so bump INPUT.classifier.promptVersion.

export interface ReferenceRow {
  category: Sector;
  favourable: string;
  unfavourable: string;
  mechanism: string;
}

export const REFERENCE: readonly ReferenceRow[] = [
  {
    category: "retail",
    favourable: "mild, dry weather",
    unfavourable: "heavy rain, floods, storms, extreme heat at midday",
    mechanism: "foot_traffic: walk-in customers stay home; flooded premises close",
  },
  {
    category: "apparel_footwear",
    favourable: "a cold wave (winter wear), first rains (rainwear), season changes",
    unfavourable: "heavy rain and floods; an unseasonal warm winter",
    mechanism: "demand_timing: purchases follow the season; foot_traffic in bad weather",
  },
  {
    category: "food_beverage",
    favourable: "heat for cold drinks and ice cream; cold for tea, coffee, hot snacks",
    unfavourable: "heavy rain and floods for walk-in outlets; drought raises ingredient prices",
    mechanism: "demand_mix: what sells shifts with temperature; foot_traffic for dine-in",
  },
  {
    category: "food_processing",
    favourable: "none in particular",
    unfavourable: "drought and heat (raw material supply, spoilage), floods (plant, stock)",
    mechanism: "production_risk: inputs and cold chain; operational_downtime when flooded",
  },
  {
    category: "delivery_ecommerce",
    favourable: "heavy rain, heat and cold: people order in instead of going out",
    unfavourable: "floods and storms that stop riders and vehicles",
    mechanism: "substitution: orders rise while delivery slows (operational_downtime)",
  },
  {
    category: "agriculture",
    favourable: "a normal monsoon",
    unfavourable: "drought, floods, heat at flowering, storms, frost in a cold wave",
    mechanism: "production_risk: crop and livestock loss",
  },
  {
    category: "construction",
    favourable: "dry weather; repair work after storms and floods",
    unfavourable: "heavy rain and floods halt sites; heat slows outdoor labour",
    mechanism: "operational_downtime: work stops; emergency_demand for repairs afterwards",
  },
  {
    category: "manufacturing",
    favourable: "none in particular",
    unfavourable: "floods (plant, stock), drought for water-intensive processes, power cuts in heat",
    mechanism: "operational_downtime and production_risk",
  },
  {
    category: "hospitality_tourism",
    favourable: "pleasant weather; a cold wave for hill stations",
    unfavourable: "floods, storms, extreme heat, drought at water-dependent destinations",
    mechanism: "demand_timing: trips are cancelled or moved; foot_traffic",
  },
  {
    category: "logistics",
    favourable: "none in particular",
    unfavourable: "floods and storms close roads; fog in a cold wave delays transport",
    mechanism: "operational_downtime: routes blocked, vehicles idle",
  },
  {
    category: "entertainment_leisure",
    favourable: "heat and rain for indoor venues (cinema, mall, gaming): people escape the weather",
    unfavourable: "any severe weather for outdoor venues; floods for all",
    mechanism: "substitution: indoor replaces outdoor; foot_traffic for outdoor venues",
  },
  {
    category: "healthcare_pharmacy",
    favourable: "heat (rehydration, sunscreen), cold and rain (cold and flu), floods (water-borne illness)",
    unfavourable: "flooded premises; damaged medicine stock",
    mechanism: "health_demand and emergency_demand",
  },
  {
    category: "home_improvement",
    favourable: "storms and floods (repairs, pumps), heat (coolers, fans), cold (heaters)",
    unfavourable: "flooded premises; heavy rain delays projects",
    mechanism: "emergency_demand after damage; demand_mix by season",
  },
  {
    category: "automotive",
    favourable: "after floods and storms (repairs), heat (AC service, batteries, tyres)",
    unfavourable: "flooded workshops and showrooms; fewer walk-ins in bad weather",
    mechanism: "emergency_demand for repairs; foot_traffic for sales",
  },
  {
    category: "other",
    favourable: "depends on the business; read the description",
    unfavourable: "floods and storms for any ground-level premises",
    mechanism: "choose the closest mechanism, or none",
  },
];

export function renderReference(): string {
  return REFERENCE.map(
    (row) =>
      `- ${row.category} | favourable: ${row.favourable} | unfavourable: ${row.unfavourable} | mechanism: ${row.mechanism}`,
  ).join("\n");
}
