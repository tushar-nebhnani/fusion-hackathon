import { createHash } from "node:crypto";
import { INPUT } from "../config.js";
import { placeFromPincode } from "../pincode.js";
import type { Operations, Profile, Sector } from "../schemas/index.js";
import { fallbackConditions } from "./defaults.js";
import { applyGuards } from "./guard.js";
import { SYSTEM_PROMPT, retryMessage, userMessage, type ClassifierInputs } from "../../../prompts/classifier.js";
import { classifierOutputSchema, type ClassifierOutput, type ImpactConditions } from "./schema.js";

export type { ClassifierInputs } from "../../../prompts/classifier.js";

// The model behind the classifier. `complete` resolves to the reply as
// parsed JSON and throws when the model cannot be reached or declines.
export interface ClassifierLlm {
  model: string;
  complete(request: { system: string; user: string }): Promise<unknown>;
}

export interface CacheKey {
  inputsHash: string;
  promptVersion: string;
  model: string;
}

export interface ClassifyDeps {
  // Without a model every business gets its sector defaults
  llm?: ClassifierLlm;
  // Earlier raw reply stored under the same key, or null
  cached?: (key: CacheKey) => Promise<unknown>;
}

export interface Classification {
  status: "ok" | "fallback";
  category: Sector;
  conditions: ImpactConditions;
  overall_confidence: number;
  model: string | null;
  prompt_version: string;
  inputs_hash: string;
  // The model's reply before the guardrails; null on fallback
  raw_output: ClassifierOutput | null;
  // Why the fallback was used
  note: string | null;
  from_cache: boolean;
}

// Picks the fields the model may see. Built in a fixed key order so the
// same business always hashes the same.
export function classifierInputs(business: {
  profile: Profile;
  operations: Operations;
  locations: { primary: { pincode: string } };
}): ClassifierInputs {
  const { profile, operations } = business;
  const place = placeFromPincode(business.locations.primary.pincode);
  return {
    sector: profile.sector,
    sub_sector: profile.sub_sector ?? null,
    description: profile.description,
    products: profile.products ?? [],
    sales_channel: profile.sales_channel ?? null,
    indoor_outdoor: profile.indoor_outdoor ?? null,
    seasonal_months: [...(operations.seasonal_months ?? [])].sort((a, b) => a - b),
    city: place.city,
    state: place.state,
  };
}

export function hashInputs(inputs: ClassifierInputs): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

type Checked = { ok: true; output: ClassifierOutput } | { ok: false; problems: string[] };

// Guardrail 1
function check(reply: unknown): Checked {
  const result = classifierOutputSchema.safeParse(reply);
  if (result.success) return { ok: true, output: result.data };
  return {
    ok: false,
    problems: result.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "reply"}: ${issue.message}`,
    ),
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

// classify(business) -> validated profile. Never throws: whatever goes
// wrong with the model, the business still gets a usable profile.
export async function classify(inputs: ClassifierInputs, deps: ClassifyDeps = {}): Promise<Classification> {
  const { llm } = deps;
  const base = {
    model: llm?.model ?? null,
    prompt_version: INPUT.classifier.promptVersion,
    inputs_hash: hashInputs(inputs),
  };

  // Guardrail 5
  const fallback = (note: string): Classification => ({
    ...base,
    status: "fallback",
    category: inputs.sector,
    conditions: fallbackConditions(inputs.sector, "the classifier could not be used"),
    overall_confidence: 0,
    raw_output: null,
    note,
    from_cache: false,
  });
  const accept = (output: ClassifierOutput, fromCache: boolean): Classification => ({
    ...base,
    status: "ok",
    category: output.category,
    conditions: applyGuards(output, inputs.sector),
    overall_confidence: output.overall_confidence,
    raw_output: output,
    note: null,
    from_cache: fromCache,
  });

  if (!llm) return fallback("classifier is not configured");

  try {
    // Guardrail 4: the same inputs, prompt and model give the stored reply
    const stored = await deps.cached?.({
      inputsHash: base.inputs_hash,
      promptVersion: base.prompt_version,
      model: llm.model,
    });
    const hit = stored === undefined || stored === null ? null : check(stored);
    if (hit?.ok) return accept(hit.output, true);

    const first = await llm.complete({ system: SYSTEM_PROMPT, user: userMessage(inputs) });
    const checked = check(first);
    if (checked.ok) return accept(checked.output, false);

    // One more try, with the reasons the first reply was refused
    const second = await llm.complete({
      system: SYSTEM_PROMPT,
      user: retryMessage(inputs, first, checked.problems),
    });
    const rechecked = check(second);
    if (rechecked.ok) return accept(rechecked.output, false);
    return fallback(`reply failed validation twice: ${rechecked.problems.join("; ")}`.slice(0, 500));
  } catch (error) {
    return fallback(`classifier unavailable: ${message(error)}`.slice(0, 500));
  }
}
