import type { AdvisorRepository } from "../repository.js";
import { RISK_FACT_KEYS, type BusinessFactView, type BusinessRecord, type FactSource } from "../types.js";

// Stored facts win over the onboarding form's, key by key
export async function getBusinessFacts(repo: AdvisorRepository, business: BusinessRecord) {
  const stored = await repo.getFacts(business.id);
  const keys = new Set(stored.map((fact) => fact.key));
  const fromForm: BusinessFactView[] = Object.entries(business.formFacts)
    .filter(([key]) => !keys.has(key))
    .map(([key, value]) => ({ key, value, source: "form", updatedAt: "onboarding form" }));
  const facts = [...stored, ...fromForm];
  const known = new Set(facts.map((fact) => fact.key));
  return {
    facts,
    // Risk facts still unknown, in the order they should be asked
    missingRiskFacts: RISK_FACT_KEYS.filter((key) => !known.has(key)),
  };
}

export async function saveBusinessFact(
  repo: AdvisorRepository,
  businessId: string,
  key: string,
  value: string,
  source: FactSource,
) {
  return repo.saveFact(businessId, key, value, source);
}
