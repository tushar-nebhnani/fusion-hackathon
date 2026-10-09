// Evaluator settings. Bump `version` when a check or the rating table changes,
// so stored evaluations say which rules produced them.
export const EVALUATOR = {
  version: "evaluator-1",
  // Requests per minute per client on /evaluate; a miss can cost a climate
  // lookup and a finance profile
  rateLimit: 30,
  // A stored finance profile is reused while it is this young, was built
  // from the business's latest snapshot and by the current finance model
  financeMaxAgeHours: 24,
  // A forecast older than this is flagged as stale
  forecastMaxAgeHours: 12,
  // Combined rating by finance band (the adjusted one when there is one)
  // and climate grade
  rating: {
    low_risk: { A: "favourable", B: "favourable", C: "favourable", D: "acceptable", E: "acceptable" },
    moderate: { A: "acceptable", B: "acceptable", C: "caution", D: "caution", E: "caution" },
    high: { A: "caution", B: "caution", C: "unfavourable", D: "unfavourable", E: "unfavourable" },
    critical: { A: "unfavourable", B: "unfavourable", C: "unfavourable", D: "unfavourable", E: "unfavourable" },
  },
  // A stress test that breaches lowers a better rating to this
  breachCeiling: "caution",
} as const;

export const RATINGS = ["favourable", "acceptable", "caution", "unfavourable", "insufficient_data"] as const;
export type Rating = (typeof RATINGS)[number];
