import { describe, expect, it } from "vitest";
import { HAZARDS } from "../../climate/types.js";
import { INPUT } from "../config.js";
import { createBusinessSchema, SECTORS } from "../schemas/index.js";
import { businessBody, fakeLlm, validReply } from "../testing/fixtures.js";
import { defaultCondition, fallbackConditions, sectorPhysical } from "./defaults.js";
import { applyGuards } from "./guard.js";
import { classifierInputs, classify, hashInputs, type ClassifierInputs } from "./index.js";
import { EXAMPLES, SYSTEM_PROMPT } from "../../../prompts/classifier.js";
import { REFERENCE } from "./reference.js";
import {
  MECHANISMS,
  classifierOutputSchema,
  impactConditionsSchema,
  overrideSchema,
} from "./schema.js";

const business = createBusinessSchema.parse(businessBody());
const INPUTS: ClassifierInputs = classifierInputs(business);

const withCondition = (hazard: (typeof HAZARDS)[number], change: object) => {
  const reply = validReply();
  return { ...reply, conditions: { ...reply.conditions, [hazard]: { ...reply.conditions[hazard], ...change } } };
};

describe("classifier output schema", () => {
  it("accepts a complete reply", () => {
    expect(classifierOutputSchema.safeParse(validReply()).success).toBe(true);
  });

  it.each([
    ["physical above 1", withCondition("heat", { physical: 1.2 })],
    ["physical below 0", withCondition("heat", { physical: -0.1 })],
    ["demand below -1", withCondition("heat", { demand: -1.5 })],
    ["demand above 1", withCondition("heat", { demand: 1.01 })],
    ["confidence above 1", withCondition("heat", { confidence: 2 })],
    ["a mechanism outside the enum", withCondition("heat", { mechanism: "vibes" })],
    ["a reason over 200 characters", withCondition("heat", { reason: "x".repeat(201) })],
    ["an empty reason", withCondition("heat", { reason: " " })],
    ["an unknown category", { ...validReply(), category: "banking" }],
    ["overall_confidence out of range", { ...validReply(), overall_confidence: 1.5 }],
  ])("refuses %s", (_name, reply) => {
    expect(classifierOutputSchema.safeParse(reply).success).toBe(false);
  });

  it("needs all six conditions and no others", () => {
    const { cold_wave: _cold, ...five } = validReply().conditions;
    expect(classifierOutputSchema.safeParse({ ...validReply(), conditions: five }).success).toBe(false);

    const extra = { ...validReply().conditions, snow: validReply().conditions.heat };
    expect(classifierOutputSchema.safeParse({ ...validReply(), conditions: extra }).success).toBe(false);
  });

  it("uses exactly the climate unit's hazard names", () => {
    expect(Object.keys(classifierOutputSchema.shape.conditions.shape)).toEqual([...HAZARDS]);
  });
});

describe("prompt", () => {
  it("has 3-4 worked examples that pass the output schema", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(3);
    expect(EXAMPLES.length).toBeLessThanOrEqual(4);
    for (const example of EXAMPLES) {
      expect(classifierOutputSchema.safeParse(example.output).success).toBe(true);
    }
  });

  it("includes the reference table, the mechanisms and the conditions", () => {
    for (const row of REFERENCE) expect(SYSTEM_PROMPT).toContain(`- ${row.category} |`);
    for (const mechanism of MECHANISMS) expect(SYSTEM_PROMPT).toContain(mechanism);
    for (const hazard of HAZARDS) expect(SYSTEM_PROMPT).toContain(`- ${hazard}:`);
  });

  it("has one reference row per sector", () => {
    expect(REFERENCE.map((row) => row.category).sort()).toEqual([...SECTORS].sort());
  });
});

describe("sector defaults", () => {
  it("has an in-range row for every sector and hazard", () => {
    for (const sector of SECTORS) {
      const conditions = Object.fromEntries(
        HAZARDS.map((hazard) => [hazard, defaultCondition(sector, hazard, "test")]),
      );
      expect(impactConditionsSchema.safeParse(conditions).success).toBe(true);
    }
  });

  it("zeroes demand in a fallback profile and keeps the physical risk", () => {
    const conditions = fallbackConditions("food_beverage", "test");

    for (const hazard of HAZARDS) {
      expect(conditions[hazard].demand).toBe(0);
      expect(conditions[hazard].physical).toBe(sectorPhysical("food_beverage", hazard));
      expect(conditions[hazard].source).toBe("sector_default");
    }
    // A demand mechanism makes no sense next to demand 0
    expect(conditions.heat.mechanism).toBe("none");
    expect(conditions.river_flood.mechanism).toBe("operational_downtime");
    expect(impactConditionsSchema.safeParse(conditions).success).toBe(true);
  });
});

describe("applyGuards", () => {
  it("leaves a confident, plausible reply as the model gave it", () => {
    const conditions = applyGuards(validReply(), "food_beverage");

    expect(conditions.heat).toEqual({ ...validReply().conditions.heat, source: "llm" });
  });

  it("raises physical to half the sector default", () => {
    // The model declares a ground-floor retailer immune to floods
    const reply = withCondition("river_flood", { physical: 0 });

    const conditions = applyGuards(reply, "retail");

    const floor = sectorPhysical("retail", "river_flood") * INPUT.classifier.physicalFloorShare;
    expect(floor).toBe(0.3);
    expect(conditions.river_flood.physical).toBe(0.3);
    expect(conditions.river_flood.demand).toBe(reply.conditions.river_flood.demand);
    expect(conditions.river_flood.source).toBe("llm");
  });

  it("does not lower a physical value that is above the floor", () => {
    const conditions = applyGuards(withCondition("river_flood", { physical: 0.95 }), "retail");

    expect(conditions.river_flood.physical).toBe(0.95);
  });

  it("uses the floor of the sector the business entered, not the model's category", () => {
    const reply = { ...withCondition("drought", { physical: 0 }), category: "retail" as const };

    const conditions = applyGuards(reply, "agriculture");

    expect(conditions.drought.physical).toBe(0.45);
  });

  it("replaces a low-confidence condition with the sector default", () => {
    const reply = withCondition("drought", { confidence: 0.49, physical: 0.9, demand: 0.9 });

    const conditions = applyGuards(reply, "food_beverage");

    expect(conditions.drought).toEqual(defaultCondition("food_beverage", "drought", "the classifier was not confident"));
    expect(conditions.drought.source).toBe("sector_default");
    // The other conditions are untouched
    expect(conditions.heat.source).toBe("llm");
  });

  it("keeps a condition at exactly the confidence threshold", () => {
    const conditions = applyGuards(withCondition("drought", { confidence: 0.5 }), "food_beverage");

    expect(conditions.drought.source).toBe("llm");
  });
});

describe("classifierInputs", () => {
  it("picks only the fields the model may see", () => {
    expect(INPUTS).toEqual({
      sector: "food_beverage",
      sub_sector: "ice cream parlour",
      description: "Ground-floor ice cream and cold drinks shop for walk-in families and students.",
      products: ["ice cream", "cold drinks"],
      sales_channel: "walk_in",
      indoor_outdoor: "indoor",
      seasonal_months: [3, 4, 5],
      city: "Mumbai",
      state: "Maharashtra",
    });
  });

  it("uses null and empty lists for what was not entered", () => {
    const { profile, operations } = business;
    const bare = classifierInputs({
      profile: { name: profile.name, sector: "other", description: profile.description, year_started: 2000 },
      operations: { power_outage_hrs_month: operations.power_outage_hrs_month, has_insurance: false },
      locations: { primary: { pincode: "999999" } },
    });

    expect(bare).toMatchObject({
      sub_sector: null,
      products: [],
      sales_channel: null,
      indoor_outdoor: null,
      seasonal_months: [],
      city: null,
      state: null,
    });
  });
});

describe("hashInputs", () => {
  it("is the same for the same inputs, whatever order the months were entered in", () => {
    const reordered = classifierInputs({
      ...business,
      operations: { ...business.operations, seasonal_months: [5, 3, 4] },
    });

    expect(hashInputs(reordered)).toBe(hashInputs(INPUTS));
    expect(hashInputs(INPUTS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field the model reads changes", () => {
    const base = hashInputs(INPUTS);
    const changes: Partial<ClassifierInputs>[] = [
      { sector: "retail" },
      { sub_sector: "bakery" },
      { description: `${INPUTS.description} Also sells tea.` },
      { products: ["ice cream"] },
      { sales_channel: "delivery" },
      { indoor_outdoor: "outdoor" },
      { seasonal_months: [3, 4] },
      { city: "Pune" },
    ];

    for (const change of changes) expect(hashInputs({ ...INPUTS, ...change })).not.toBe(base);
  });
});

describe("classify", () => {
  it("returns the model's profile with the guardrails applied", async () => {
    const { llm, requests } = fakeLlm([withCondition("river_flood", { physical: 0 })]);

    const result = await classify(INPUTS, { llm });

    expect(result).toMatchObject({
      status: "ok",
      category: "food_beverage",
      overall_confidence: 0.8,
      model: "fake-model",
      prompt_version: INPUT.classifier.promptVersion,
      inputs_hash: hashInputs(INPUTS),
      note: null,
      from_cache: false,
    });
    expect(result.conditions.river_flood.physical).toBe(0.3);
    // The raw reply is kept as the model gave it
    expect(result.raw_output?.conditions.river_flood.physical).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("sends the model only the classifier inputs", async () => {
    const { llm, requests } = fakeLlm();

    await classify(INPUTS, { llm });

    const request = requests[0];
    expect(request?.system).toBe(SYSTEM_PROMPT);
    expect(JSON.parse(request?.user ?? "")).toEqual(INPUTS);
    const sent = `${request?.system ?? ""}${request?.user ?? ""}`;
    for (const secret of ["Sharma Cold Drinks", "Ravi", "+919876543210", "19.076", "27ABCDE1234F1Z5", "UDYAM-", "400014"]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("retries once with the validation errors, then accepts the corrected reply", async () => {
    const bad = withCondition("heat", { physical: 1.4 });
    const { llm, requests } = fakeLlm([bad, validReply()]);

    const result = await classify(INPUTS, { llm });

    expect(result.status).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("conditions.heat.physical");
    expect(requests[1]?.user).toContain(JSON.stringify(bad));
    expect(requests[1]?.user).toContain(JSON.stringify(INPUTS));
  });

  it("falls back to the sector defaults when validation fails twice", async () => {
    const { conditions: _conditions, ...incomplete } = validReply();
    const { llm, requests } = fakeLlm([incomplete, incomplete, validReply()]);

    const result = await classify(INPUTS, { llm });

    expect(requests).toHaveLength(2);
    expect(result.status).toBe("fallback");
    expect(result.note).toContain("reply failed validation twice");
    expect(result.conditions).toEqual(
      fallbackConditions("food_beverage", "the classifier could not be used"),
    );
    expect(result.category).toBe("food_beverage");
    expect(result.overall_confidence).toBe(0);
    expect(result.raw_output).toBeNull();
  });

  it("falls back when the model cannot be reached", async () => {
    const { llm, state, requests } = fakeLlm();
    state.failing = true;

    const result = await classify(INPUTS, { llm });

    expect(result).toMatchObject({ status: "fallback", note: "classifier unavailable: model down" });
    expect(requests).toHaveLength(1);
  });

  it("falls back without a model", async () => {
    const result = await classify(INPUTS);

    expect(result).toMatchObject({ status: "fallback", model: null, note: "classifier is not configured" });
    expect(Object.values(result.conditions).every((condition) => condition.demand === 0)).toBe(true);
  });

  it("answers from the cache without calling the model", async () => {
    const { llm, requests } = fakeLlm();
    const keys: unknown[] = [];
    const cached = (key: unknown) => {
      keys.push(key);
      return Promise.resolve(validReply({ overall_confidence: 0.66 }));
    };

    const result = await classify(INPUTS, { llm, cached });

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ status: "ok", from_cache: true, overall_confidence: 0.66 });
    expect(keys).toEqual([
      { inputsHash: hashInputs(INPUTS), promptVersion: INPUT.classifier.promptVersion, model: "fake-model" },
    ]);
  });

  it("calls the model on a cache miss or a cached reply that no longer validates", async () => {
    for (const stored of [null, { category: "food_beverage" }]) {
      const { llm, requests } = fakeLlm();

      const result = await classify(INPUTS, { llm, cached: () => Promise.resolve(stored) });

      expect(requests).toHaveLength(1);
      expect(result).toMatchObject({ status: "ok", from_cache: false });
    }
  });

  it("gives the same profile for the same business every time", async () => {
    const first = await classify(INPUTS, { llm: fakeLlm().llm });
    const second = await classify(INPUTS, { llm: fakeLlm().llm });

    expect(second).toEqual(first);
  });
});

describe("override schema", () => {
  it("accepts a partial change with a reason", () => {
    const body = { reason: "Shop is on a raised plinth", conditions: { river_flood: { physical: 0.2 } } };

    expect(overrideSchema.safeParse(body).success).toBe(true);
    expect(overrideSchema.safeParse({ reason: "Wrong category", category: "retail" }).success).toBe(true);
  });

  it.each([
    ["no reason", { conditions: { heat: { demand: 0.1 } } }],
    ["nothing to change", { reason: "Just checking" }],
    ["empty changes", { reason: "Just checking", conditions: { heat: {} } }],
    ["an out-of-range value", { reason: "Too high", conditions: { heat: { physical: 2 } } }],
    ["an unknown condition", { reason: "Snow day", conditions: { snow: { physical: 0.5 } } }],
    ["a source the bank cannot set", { reason: "Sneaky", conditions: { heat: { source: "llm" } } }],
  ])("refuses %s", (_name, body) => {
    expect(overrideSchema.safeParse(body).success).toBe(false);
  });
});
