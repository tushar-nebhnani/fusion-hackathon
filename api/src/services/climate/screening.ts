import { HAZARD_CATALOG, LIMITS } from "./hazards.js";
import type {
  Relevance,
  RiverIndicators,
  WeatherHazard,
  WeatherIndicators,
} from "./types.js";

export interface Screened {
  relevance: Relevance;
  indicatorValue: number | null;
  primaryThreshold: number;
  reason: string;
}

// At or above `primary` is primary, below `dormant` is dormant, else secondary
export function classify(value: number, primary: number, dormant: number): Relevance {
  if (value >= primary) return "primary";
  if (value < dormant) return "dormant";
  return "secondary";
}

function screenBy(hazard: WeatherHazard, value: number, reason: string): Screened {
  const { primaryThreshold, dormantThreshold } = HAZARD_CATALOG[hazard];
  return {
    relevance: classify(value, primaryThreshold, dormantThreshold),
    indicatorValue: value,
    primaryThreshold,
    reason,
  };
}

const perYear = (value: number) => `${value.toFixed(1)} days per year`;

export function screenWeather(ind: WeatherIndicators): Record<WeatherHazard, Screened> {
  const droughtEvery =
    ind.droughtYearShare > 0
      ? `about 1 in ${Math.max(1, Math.round(1 / ind.droughtYearShare))} years`
      : "no year on record";
  return {
    flash_flood: screenBy(
      "flash_flood",
      ind.heavyRainDaysPerYear,
      `Rain of ${LIMITS.heavyRainMm} mm or more on ${perYear(ind.heavyRainDaysPerYear)}`,
    ),
    heat: screenBy(
      "heat",
      ind.heatDaysPerYear,
      `Max temperature above ${LIMITS.heatC}°C on ${perYear(ind.heatDaysPerYear)}`,
    ),
    drought: screenBy(
      "drought",
      ind.droughtYearShare,
      `Weak monsoon (below 75% of normal) in ${droughtEvery}`,
    ),
    storm: screenBy(
      "storm",
      ind.stormDaysPerYear,
      `Gusts above ${LIMITS.gustKmh} km/h on ${perYear(ind.stormDaysPerYear)}`,
    ),
    cold_wave: screenBy(
      "cold_wave",
      ind.coldDaysPerYear,
      `Min temperature below ${LIMITS.coldC}°C on ${perYear(ind.coldDaysPerYear)}`,
    ),
  };
}

// `river` is null when the cell has no modelled river. `sourceFailed` means
// the discharge history could not be fetched at all.
export function screenRiver(
  river: RiverIndicators | null,
  exposureShare: number | null,
  sourceFailed = false,
): Screened {
  const { primaryThreshold, dormantThreshold } = HAZARD_CATALOG.river_flood;
  const smallRiver = river === null || river.dischargeP99 < dormantThreshold;

  if (exposureShare !== null) {
    const percent = `${(exposureShare * 100).toFixed(1)}%`;
    let relevance: Relevance = "secondary";
    if (exposureShare >= LIMITS.exposurePrimary) relevance = "primary";
    else if (exposureShare < LIMITS.exposureDormant && smallRiver && !sourceFailed) {
      relevance = "dormant";
    }
    return {
      relevance,
      indicatorValue: exposureShare,
      primaryThreshold: LIMITS.exposurePrimary,
      reason: `Flood exposure share of ${percent}`,
    };
  }

  if (sourceFailed) {
    return {
      relevance: "secondary",
      indicatorValue: null,
      primaryThreshold,
      reason: "River discharge history unavailable; treated as secondary",
    };
  }

  if (river === null) {
    return {
      relevance: "dormant",
      indicatorValue: 0,
      primaryThreshold,
      reason: "No river discharge modelled for this cell",
    };
  }

  return {
    relevance: classify(river.dischargeP99, primaryThreshold, dormantThreshold),
    indicatorValue: river.dischargeP99,
    primaryThreshold,
    reason: `99th-percentile river discharge of ${river.dischargeP99.toFixed(0)} m³/s`,
  };
}
