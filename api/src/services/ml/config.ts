import "dotenv/config";
import { z } from "zod";

// Every tunable number of the ML proxy. The models themselves are tuned in `ml/`.
export const ML = {
  // Requests per minute per client on /ml; each one runs a model or 20,000 simulated paths
  rateLimit: 30,
  timeoutMs: 8_000,
  // Daily weather values an alert may carry, ending on the alert day
  weatherMaxDays: 60,
  // Monthly revenue the anomaly model needs and accepts
  anomaly: { minMonths: 13, maxMonths: 120 },
} as const;

export interface MlEnv {
  // Base URL of the Python service in `ml/`; null leaves /ml answering 503
  url: string | null;
}

// Read apart from config/env.ts, like the finance settings: an invalid value
// here falls back to its default and never stops the API.
const schema = z.object({ ML_SERVICE_URL: z.url().optional().catch(undefined) });

export function loadMlEnv(source: NodeJS.ProcessEnv = process.env): MlEnv {
  return { url: schema.parse(source).ML_SERVICE_URL ?? null };
}
