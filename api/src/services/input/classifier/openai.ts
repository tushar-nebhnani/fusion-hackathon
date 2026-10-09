import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { INPUT } from "../config.js";
import type { ClassifierLlm } from "./index.js";
import { classifierWireSchema } from "./schema.js";

export interface OpenAiClassifierOptions {
  apiKey: string;
  model: string;
  // Test seam; the real client is built from `apiKey`
  client?: Pick<OpenAI, "responses">;
}

// Reasoning models refuse a `temperature`; they get a low reasoning effort
// instead. For them the stored reply (the cache) is what keeps a business's
// profile from changing between runs.
const REASONING_MODEL = /^(gpt-5|o\d)/;

export function createOpenAiClassifier(options: OpenAiClassifierOptions): ClassifierLlm {
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      timeout: INPUT.classifier.timeoutMs,
      maxRetries: INPUT.classifier.maxRetries,
    });
  const sampling = REASONING_MODEL.test(options.model)
    ? { reasoning: { effort: "low" as const } }
    : { temperature: INPUT.classifier.temperature };

  return {
    model: options.model,

    async complete({ system, user }) {
      const response = await client.responses.parse({
        model: options.model,
        max_output_tokens: INPUT.classifier.maxTokens,
        instructions: system,
        input: user,
        ...sampling,
        text: { format: zodTextFormat(classifierWireSchema, "weather_impact_profile") },
        // Business descriptions are not kept on OpenAI's side
        store: false,
      });
      const refused = response.output.some(
        (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
      );
      if (refused) throw new Error("request declined");
      if (response.status === "incomplete" || response.output_parsed === null) {
        throw new Error("reply was cut off or did not match the expected shape");
      }
      return response.output_parsed;
    },
  };
}
