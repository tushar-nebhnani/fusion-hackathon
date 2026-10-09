import type {
  ClimateAgent,
  ForecastScoreInput,
  ForecastScores,
  ScreeningReviewInput,
  ScreeningVerdict,
} from "../agent.js";
import type { Hazard, Relevance } from "../types.js";

// Scripted agent. By default it agrees with every rule category and returns
// every rule score, so tests only state what they want changed.
export function fakeAgent(
  script: {
    categories?: Partial<Record<Hazard, Relevance>>;
    scores?: Partial<Record<Hazard, number>>;
  } = {},
) {
  const calls: ("review" | "score")[] = [];
  const reviews: ScreeningReviewInput[] = [];
  const scored: ForecastScoreInput[] = [];
  const state = { failing: false };

  const agent: ClimateAgent = {
    version: "fake-agent/1",
    reviewScreening(input) {
      calls.push("review");
      reviews.push(input);
      if (state.failing) return Promise.reject(new Error("agent down"));
      return Promise.resolve(
        input.hazards.map(
          (h): ScreeningVerdict => ({
            hazard: h.hazard,
            category: script.categories?.[h.hazard] ?? h.ruleCategory,
            rationale: `fake rationale for ${h.hazard}`,
          }),
        ),
      );
    },
    scoreForecast(input) {
      calls.push("score");
      scored.push(input);
      if (state.failing) return Promise.reject(new Error("agent down"));
      const scores = {} as ForecastScores;
      for (const h of input.hazards) {
        scores[h.hazard] = {
          score: script.scores?.[h.hazard] ?? h.ruleScore,
          note: `fake note for ${h.hazard}`,
        };
      }
      return Promise.resolve(scores);
    },
  };
  return { agent, calls, reviews, scored, state };
}
