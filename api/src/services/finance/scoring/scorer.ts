import { z } from "zod";
import { FINANCE, type FinanceEnv } from "../config.js";
import type { FinanceMetrics } from "../metrics/compute.js";
import { baselineScore, riskBand, type ScoreResult } from "./baseline.js";

// The one place a baseline score comes from. The rules are the default; a
// trained model can be plugged in behind the same interface (README
// section 7) without the rest of the pipeline changing.

export interface ScoreOutcome {
  result: ScoreResult;
  // Set when the chosen scorer failed and the rules answered instead
  fallback: string | null;
}

export interface Scorer {
  readonly name: "rules" | "ml";
  score(metrics: FinanceMetrics): Promise<ScoreOutcome>;
}

export const rulesScorer: Scorer = {
  name: "rules",
  score: (metrics) => Promise.resolve({ result: baselineScore(metrics), fallback: null }),
};

export interface MlScorerOptions {
  // The Python model's scoring endpoint
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const mlReplySchema = z.object({ score: z.number().min(0).max(100) });

// Stub for the trained model, which is not built. It posts the metrics to
// `url` and expects `{ "score": 0-100 }` back. The band is always taken from
// our own thresholds and the sub-scores stay rule-based, so a profile can
// still be explained. Any failure answers with the rules.
export function createMlScorer(options: MlScorerOptions): Scorer {
  const send = options.fetch ?? fetch;
  return {
    name: "ml",
    async score(metrics) {
      const rules = baselineScore(metrics);
      try {
        const response = await send(options.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model_version: FINANCE.modelVersion, metrics }),
          signal: AbortSignal.timeout(options.timeoutMs ?? FINANCE.ml.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
        const score = Math.round(mlReplySchema.parse(await response.json()).score);
        return {
          result: { score, band: riskBand(score), sub_scores: rules.sub_scores, source: "ml" },
          fallback: null,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        return { result: rules, fallback: `ml_scorer_failed: ${reason}` };
      }
    },
  };
}

// `FINANCE_SCORER=ml` needs `FINANCE_ML_URL`; without it the rules are used
export function chooseScorer(env: FinanceEnv, fetchFn?: typeof fetch): Scorer {
  return env.scorer === "ml" && env.mlUrl
    ? createMlScorer({ url: env.mlUrl, fetch: fetchFn })
    : rulesScorer;
}
