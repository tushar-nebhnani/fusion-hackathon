import type { ClimateProfile } from "../climate/schema.js";
import type { Hazard } from "../climate/types.js";
import type { FinanceProfile } from "../finance/profile/schema.js";
import { EVALUATOR, RATINGS, type Rating } from "./config.js";
import type { Check } from "./schema.js";

const label = (hazard: string) => hazard.replace(/_/g, " ");

export function breachedHazards(profile: FinanceProfile): Hazard[] {
  return Object.entries(profile.stress)
    .filter(([, stress]) => stress.breach)
    .map(([hazard]) => hazard as Hazard);
}

// One rating from the finance band and the climate grade. A failed check,
// or a missing finance or climate profile, gives insufficient_data.
export function combinedRating(
  checks: Check[],
  climate: ClimateProfile | null,
  finance: FinanceProfile | null,
): Rating {
  if (checks.some((check) => check.status === "fail") || !climate || !finance) return "insufficient_data";
  const band = finance.adjusted?.band ?? finance.baseline.band;
  const rating: Rating = EVALUATOR.rating[band][climate.grade];
  // Ratings are ordered best first; a breach caps how good it can be
  if (breachedHazards(finance).length > 0 && RATINGS.indexOf(rating) < RATINGS.indexOf(EVALUATOR.breachCeiling)) {
    return EVALUATOR.breachCeiling;
  }
  return rating;
}

// Plain sentences built from the numbers, most important first
export function reasons(checks: Check[], climate: ClimateProfile | null, finance: FinanceProfile | null): string[] {
  const out: string[] = [];
  for (const check of checks.filter((c) => c.status === "fail")) out.push(`Not reliable: ${check.detail}.`);

  if (finance) {
    const { baseline, adjusted } = finance;
    out.push(
      adjusted
        ? `Finance: climate-adjusted score ${adjusted.score} (${label(adjusted.band)}), baseline ${baseline.score} (${label(baseline.band)}).`
        : `Finance: baseline score ${baseline.score} (${label(baseline.band)}); no climate adjustment.`,
    );
    const breached = breachedHazards(finance);
    if (breached.length > 0) out.push(`Stress test breached for ${breached.map(label).join(", ")}.`);
    const drivers = [...(adjusted?.drivers ?? [])].sort((a, b) => a.points_change - b.points_change).slice(0, 2);
    for (const driver of drivers) out.push(driver.reason);
  } else {
    out.push("Finance: no finance profile for this business.");
  }

  if (climate) {
    const main = climate.hazards.filter((h) => h.relevance === "primary").map((h) => label(h.hazard));
    out.push(
      `Climate: grade ${climate.grade}, overall risk ${climate.overall_climate_risk}` +
        (main.length > 0 ? `; primary hazards ${main.join(", ")}.` : "; no primary hazard."),
    );
    if (climate.active_events.length > 0) {
      out.push(`${climate.active_events.length} active forecast event(s) at this location.`);
    }
  }

  for (const check of checks.filter((c) => c.status === "warn")) out.push(`Caveat: ${check.detail}.`);
  return out;
}
