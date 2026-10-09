import type { ClimateService } from "../../climate/profile.service.js";
import type { ClimateProfile } from "../../climate/schema.js";
import { MONTHS, type BusinessRecord, type Hazard, type MonthName } from "../types.js";

// Read-only wrapper over the climate unit's public entry function. The
// profile comes back exactly as the climate unit returns it.
export async function getClimateProfile(
  climate: Pick<ClimateService, "getProfile">,
  business: BusinessRecord,
): Promise<ClimateProfile> {
  return climate.getProfile({ lat: business.lat, lon: business.lon }, `advisor:${business.id}`);
}

// Hazards worth a scenario. README §5 says "medium or higher"; the climate
// unit's categories are primary / secondary / dormant.
export function materialHazards(profile: ClimateProfile): Hazard[] {
  return profile.hazards
    .filter((hazard) => hazard.relevance !== "dormant" || hazard.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .map((hazard) => hazard.hazard);
}

const months = (...names: MonthName[]) => names;

// The climate profile has no seasonality, so the months a hazard usually
// strikes come from this static table. It is India-wide, with one regional
// rule: the Tamil Nadu / south Andhra coast floods in the north-east monsoon.
export function hazardSeasons(business: Pick<BusinessRecord, "lat" | "lon">) {
  const southEastCoast = business.lat < 16 && business.lon > 78.5;
  const flood = southEastCoast ? months("Oct", "Nov", "Dec") : months("Jul", "Aug", "Sep");
  const seasons: Record<Hazard, MonthName[]> = {
    river_flood: flood,
    flash_flood: southEastCoast ? flood : months("Jun", "Jul", "Aug", "Sep"),
    heat: months("Apr", "May", "Jun"),
    drought: months("Jul", "Aug", "Sep"),
    storm: southEastCoast ? months("Oct", "Nov", "Dec") : months("May", "Oct", "Nov"),
    cold_wave: months("Dec", "Jan"),
  };
  return {
    source: "advisor static seasonality table (India-wide, not location-specific data)",
    region: southEastCoast ? "south-east coast (north-east monsoon)" : "rest of India (south-west monsoon)",
    seasons,
  };
}

export const monthNumber = (name: string): number | null => {
  const index = MONTHS.findIndex((month) => month.toLowerCase() === name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
};
