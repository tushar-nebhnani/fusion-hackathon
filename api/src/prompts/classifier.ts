// System prompt and messages for the weather-impact classifier
// (services/input/classifier). Bump INPUT.classifier.promptVersion whenever
// one changes.
import { INPUT } from "../services/input/config.js";
import type { Sector } from "../services/input/schemas/profile.js";
import { renderReference } from "../services/input/classifier/reference.js";
import {
  MECHANISMS,
  type ClassifierOutput,
  type Mechanism,
} from "../services/input/classifier/schema.js";

// Everything the model is told about a business, and nothing else: no name,
// contacts, coordinates, financials, loan details or registration numbers.
export interface ClassifierInputs {
  sector: Sector;
  sub_sector: string | null;
  description: string;
  products: string[];
  sales_channel: string | null;
  indoor_outdoor: string | null;
  seasonal_months: number[];
  city: string | null;
  state: string | null;
}

const c = (
  physical: number,
  demand: number,
  mechanism: Mechanism,
  confidence: number,
  reason: string,
) => ({ physical, demand, mechanism, confidence, reason });

// Worked examples. A test checks each output against the output schema.
export const EXAMPLES: readonly { input: ClassifierInputs; output: ClassifierOutput }[] = [
  {
    input: {
      sector: "food_beverage",
      sub_sector: "ice cream parlour",
      description:
        "Ground-floor ice cream and cold drinks parlour on a busy market street. Customers are walk-in families and students.",
      products: ["ice cream", "milkshakes", "cold drinks"],
      sales_channel: "walk_in",
      indoor_outdoor: "indoor",
      seasonal_months: [3, 4, 5, 6],
      city: "Mumbai",
      state: "Maharashtra",
    },
    output: {
      category: "food_beverage",
      conditions: {
        river_flood: c(0.8, -0.4, "operational_downtime", 0.75, "Ground-floor shop closes and loses frozen stock when the street floods"),
        flash_flood: c(0.5, -0.6, "foot_traffic", 0.85, "Walk-in only; heavy rain keeps customers home"),
        heat: c(0.15, 0.8, "demand_mix", 0.9, "Ice cream and cold drinks sell far more in heat; freezers work harder"),
        drought: c(0.1, 0.1, "demand_mix", 0.55, "Dry hot spells lift cold drink sales slightly; milk prices may rise"),
        storm: c(0.5, -0.5, "foot_traffic", 0.75, "Storms empty the street and power cuts threaten frozen stock"),
        cold_wave: c(0.05, -0.5, "demand_mix", 0.8, "Cold weather cuts demand for ice cream"),
      },
      overall_confidence: 0.8,
    },
  },
  {
    input: {
      sector: "delivery_ecommerce",
      sub_sector: "cloud kitchen",
      description:
        "Delivery-only kitchen selling North Indian meals through food delivery apps. No dine-in; riders collect orders from a first-floor unit.",
      products: ["thali", "biryani", "rolls"],
      sales_channel: "delivery",
      indoor_outdoor: "indoor",
      seasonal_months: [],
      city: "Bengaluru",
      state: "Karnataka",
    },
    output: {
      category: "delivery_ecommerce",
      conditions: {
        river_flood: c(0.6, -0.2, "operational_downtime", 0.65, "Upper-floor kitchen is safe but riders cannot reach flooded areas"),
        flash_flood: c(0.3, 0.6, "substitution", 0.85, "People order in when it pours; deliveries slow down"),
        heat: c(0.15, 0.4, "substitution", 0.75, "Customers avoid going out in heat and order more"),
        drought: c(0.1, 0, "none", 0.6, "Little direct effect beyond ingredient prices"),
        storm: c(0.5, 0.2, "operational_downtime", 0.7, "Orders rise but riders stop during storms"),
        cold_wave: c(0.05, 0.2, "substitution", 0.6, "Mild lift in hot meal orders on cold evenings"),
      },
      overall_confidence: 0.75,
    },
  },
  {
    input: {
      sector: "construction",
      sub_sector: "civil contractor",
      description:
        "Small civil contractor building houses and doing road repair for the municipality. All work is on open outdoor sites with daily-wage labour.",
      products: [],
      sales_channel: "b2b",
      indoor_outdoor: "outdoor",
      seasonal_months: [11, 12, 1, 2, 3],
      city: "Guwahati",
      state: "Assam",
    },
    output: {
      category: "construction",
      conditions: {
        river_flood: c(0.9, 0.2, "operational_downtime", 0.85, "Sites are under water and work stops; repair contracts follow later"),
        flash_flood: c(0.8, 0, "operational_downtime", 0.9, "Outdoor work halts in heavy rain"),
        heat: c(0.5, 0, "operational_downtime", 0.8, "Outdoor labour slows and midday work stops in extreme heat"),
        drought: c(0.2, 0, "production_risk", 0.6, "Water for curing and mixing gets scarce"),
        storm: c(0.8, 0.2, "operational_downtime", 0.8, "Work stops and materials are damaged; repair demand rises after"),
        cold_wave: c(0.15, 0, "none", 0.6, "Little effect in this region"),
      },
      overall_confidence: 0.8,
    },
  },
  {
    input: {
      sector: "healthcare_pharmacy",
      sub_sector: "pharmacy",
      description:
        "Neighbourhood medical store selling prescription and over-the-counter medicines to walk-in customers, with home delivery nearby.",
      products: ["medicines", "ORS", "sunscreen"],
      sales_channel: "both",
      indoor_outdoor: "indoor",
      seasonal_months: [],
      city: "Delhi",
      state: "Delhi",
    },
    output: {
      category: "healthcare_pharmacy",
      conditions: {
        river_flood: c(0.6, 0.3, "emergency_demand", 0.7, "Shop may flood, but water-borne illness raises medicine demand"),
        flash_flood: c(0.3, 0.3, "health_demand", 0.75, "Cold, flu and fever medicines sell more in the rains"),
        heat: c(0.05, 0.5, "health_demand", 0.85, "ORS, sunscreen and heat-illness medicines sell more"),
        drought: c(0.05, 0.1, "health_demand", 0.55, "Slight rise in dehydration-related sales"),
        storm: c(0.3, 0.1, "emergency_demand", 0.65, "Brief closure, then first-aid demand"),
        cold_wave: c(0.05, 0.5, "health_demand", 0.85, "Cough, cold and flu medicines sell more"),
      },
      overall_confidence: 0.8,
    },
  },
];

export const SYSTEM_PROMPT = `You assess how weather affects one small business in India, for a lender.

You receive a JSON object describing the business: sector, sub_sector, description, products, sales_channel, indoor_outdoor, seasonal_months (peak revenue months, 1-12) and city/state. Fields may be null or empty. Base your answer on the description first.

For each of the six conditions, give two separate effects:
- physical (0 to 1): how much the condition stops the business from operating: flooded premises, halted work, crop loss, damaged stock, staff or deliveries unable to move. It is always a risk; it never helps.
- demand (-1 to 1): how the condition changes what customers buy. Negative means demand drops, positive means it rises, 0 means no clear change.
The two are independent. A delivery kitchen in heavy rain has physical 0.3 (riders slow down) and demand 0.6 (more orders).

Conditions:
- river_flood: a river overflows and water stands in the area for days
- flash_flood: very heavy rain and waterlogging. Use this for the effect of rain on foot traffic and deliveries.
- heat: heatwave
- drought: failed or weak monsoon, water shortage
- storm: cyclone, high wind, thunderstorm
- cold_wave: unusually cold days, fog

Also give for each condition:
- mechanism: the main way the effect happens, one of ${MECHANISMS.join(", ")}
- confidence (0 to 1): how sure you are. Use below 0.5 when the description does not tell you enough.
- reason: one plain sentence, at most ${String(INPUT.classifier.reasonMaxChars)} characters

category is the reference category that fits the business best; it may differ from the sector given. overall_confidence (0 to 1) is how well the description let you judge the business as a whole.

Rules:
- Use the city and state: a cold wave matters in Delhi and little in Chennai.
- Premises at ground level in India are exposed to floods. Do not rate physical near 0 for a flood unless the description gives a reason.
- Do not invent facts that are not in the input.

Reference table (category | favourable | unfavourable | mechanism):
${renderReference()}

Examples:
${EXAMPLES.map((example) => `Input: ${JSON.stringify(example.input)}\nOutput: ${JSON.stringify(example.output)}`).join("\n\n")}`;

export function userMessage(inputs: ClassifierInputs): string {
  return JSON.stringify(inputs);
}

// Sent when the first reply failed validation: the same business, the reply
// that was refused, and what was wrong with it
export function retryMessage(inputs: ClassifierInputs, previous: unknown, problems: string[]): string {
  return [
    userMessage(inputs),
    `Your previous reply was rejected:\n${JSON.stringify(previous)}`,
    `Problems:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    "Reply again for the same business with every problem fixed.",
  ].join("\n\n");
}
