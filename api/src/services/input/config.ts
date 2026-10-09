import "dotenv/config";
import { z } from "zod";

// Input service constants (README sections 2 to 4)
export const INPUT = {
  // Stored with every snapshot; bump when a formula in derive.ts changes
  derivationVersion: "derive-1",
  // Version of the consent text the owner agreed to
  consentVersion: "consent-1",
  // Supplier shares must sum to 1.0 within this
  supplierShareTolerance: 0.02,
  // "Today" and "this year" are taken in this zone
  timezone: "Asia/Kolkata",
  // Requests per minute per client on the input routes
  rateLimit: 60,
  // How long a save waits for the climate unit or the finance service
  // before answering `scoring: "pending"`
  triggerTimeoutMs: 15_000,
  // How often unfinished classifications and trigger jobs are tried again
  retryMinutes: 5,
  classifier: {
    // Part of the cache key; bump when src/prompts/classifier.ts or classifier/reference.ts changes
    promptVersion: "impact-1",
    temperature: 0,
    maxTokens: 4_000,
    timeoutMs: 30_000,
    maxRetries: 2,
    // `physical` cannot go below this share of the sector default
    physicalFloorShare: 0.5,
    // Below this confidence a condition falls back to the sector default
    minConfidence: 0.5,
    reasonMaxChars: 200,
  },
} as const;

export interface InputEnv {
  classifierEnabled: boolean;
  classifierModel: string;
  seedFile: string;
}

// Read apart from config/env.ts, like the alert settings: an invalid value
// here falls back to its default and never stops the API.
const schema = z.object({
  INPUT_CLASSIFIER_ENABLED: z.enum(["true", "false"]).catch("true"),
  INPUT_CLASSIFIER_MODEL: z.string().min(1).catch("gpt-4.1-mini"),
  INPUT_SEED_FILE: z.string().min(1).catch("data/smes.json"),
});

export function loadInputEnv(source: NodeJS.ProcessEnv = process.env): InputEnv {
  const parsed = schema.parse(source);
  return {
    classifierEnabled: parsed.INPUT_CLASSIFIER_ENABLED === "true",
    classifierModel: parsed.INPUT_CLASSIFIER_MODEL,
    seedFile: parsed.INPUT_SEED_FILE,
  };
}
