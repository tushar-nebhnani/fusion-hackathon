import { HAZARDS, type BusinessRecord, type Hazard, type WeatherImpactEntry } from "../types.js";

export type WeatherImpactView = WeatherImpactEntry | { effect: "unknown" };

// The `weatherImpact` field of the business record: the input service's
// weather-impact classifier (inputDirectory.ts) or, for a demo business,
// smes.json. A hazard with no entry is "unknown" (README §6). The agent must
// then say the impact is unknown rather than assume one.
export function getWeatherImpact(business: BusinessRecord) {
  const known = business.weatherImpact ?? {};
  const hazards = Object.fromEntries(
    HAZARDS.map((hazard): [Hazard, WeatherImpactView] => [hazard, known[hazard] ?? { effect: "unknown" }]),
  ) as Record<Hazard, WeatherImpactView>;
  return {
    source: business.weatherImpact
      ? business.origin === "input"
        ? "input service: weather-impact classifier"
        : "demo business: smes.json weatherImpact field"
      : "none: the classifier has not rated this business",
    hazards,
  };
}

// Sensitivity used by simulateScenario. An unknown impact is treated as a
// full loss on the closure days, the conservative choice, and labelled so.
export function sensitivityFor(business: BusinessRecord, hazard: Hazard) {
  const entry = business.weatherImpact?.[hazard];
  return entry
    ? { sensitivity: entry.sensitivity, sensitivitySource: "weather_impact" as const }
    : { sensitivity: 1, sensitivitySource: "assumed_full_loss_unknown_impact" as const };
}
