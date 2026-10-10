import type { AdvisorRepository } from "../repository.js";
import { RISK_FACT_KEYS, type BusinessFactView, type BusinessRecord, type FactSource } from "../types.js";

// What the owner says, in chat or on the form, is their claim; nobody has
// checked it. Only what the bank recorded has been.
export type FactStanding = "owner_claimed" | "bank_recorded";
const standingOf = (source: FactSource): FactStanding => (source === "bank" ? "bank_recorded" : "owner_claimed");

// Stored facts win over the onboarding form's, key by key
export async function getBusinessFacts(repo: AdvisorRepository, business: BusinessRecord) {
  const stored = await repo.getFacts(business.id);
  const keys = new Set(stored.map((fact) => fact.key));
  const fromForm: BusinessFactView[] = Object.entries(business.formFacts)
    .filter(([key]) => !keys.has(key))
    .map(([key, value]) => ({ key, value, source: "form", updatedAt: "onboarding form" }));
  const facts = [...stored, ...fromForm].map((fact) => ({ ...fact, standing: standingOf(fact.source) }));
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
  // A chat message cannot replace what the bank recorded
  if (source !== "bank") {
    const current = (await repo.getFacts(businessId)).find((fact) => fact.key === key);
    if (current?.source === "bank") {
      throw new Error(`${key} was recorded by the bank and cannot be changed in chat`);
    }
  }
  const saved = await repo.saveFact(businessId, key, value, source);
  return { ...saved, standing: standingOf(saved.source) };
}
