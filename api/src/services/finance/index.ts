// The finance service's public surface. `createFinanceService(deps)` returns
// the entry function and the tool-ready functions of README section 8:
//
//   getFinanceProfile(businessId)
//   simulateScenario(businessId, { hazard, severity, duration_months })
//   evaluateLocation(businessDraft, lat, lon)
//   repaymentCapacity(businessId, { revenue_drop_pct, months })
//
// Each returns plain JSON with a `summary` built from the numbers, so an
// agent can call it as a tool.

export { FINANCE, loadFinanceEnv, type FinanceEnv } from "./config.js";
export { financeProfileSchema, type FinanceProfile } from "./profile/schema.js";
export { chooseScorer, createMlScorer, rulesScorer, type Scorer } from "./scoring/scorer.js";
export {
  createFinanceService,
  type FinanceService,
  type FinanceServiceDeps,
  type LocationEvaluation,
  type ProfileOptions,
  type RepaymentCapacity,
  type ScenarioResult,
} from "./service.js";
