import type { Hazard, Relevance } from "./types.js";

export interface HazardDefinition {
  hazard: Hazard;
  description: string;
  apis: string[];
  screeningVariables: string[];
  // Forecast variables fetched while the hazard is primary or secondary
  currentVariables: string[];
  currentHourlyVariables: string[];
  tripwireVariables: string[];
  indicatorRule: string;
  primaryThreshold: number;
  dormantThreshold: number;
}

// Fixed cut-offs behind the screening indicators
export const LIMITS = {
  heatC: 40,
  severeHeatC: 45,
  coldC: 4,
  severeColdC: 0,
  gustKmh: 60,
  severeGustKmh: 90,
  // Fixed daily total: a percentile of a cell's own history is exceeded
  // on the same share of days everywhere, so it cannot rank cells.
  heavyRainMm: 50,
  // No rain event is raised below this 3-day total, however dry the cell
  minEventRainMm: 30,
  droughtMonsoonShare: 0.75,
  // WB flood exposure share, used for river_flood when it is available
  exposurePrimary: 0.2,
  exposureDormant: 0.02,
} as const;

export const TRIPWIRE_VARIABLES = ["precipitation_sum", "temperature_2m_max"];

export const ARCHIVE_VARIABLES = [
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "precipitation_sum",
  "precipitation_hours",
  "et0_fao_evapotranspiration",
  "wind_gusts_10m_max",
  "wind_speed_10m_max",
];

export const CLIMATE_VARIABLES = [
  "temperature_2m_max",
  "precipitation_sum",
  "soil_moisture_0_to_10cm_mean",
];

export const FLOOD_FORECAST_VARIABLES = [
  "river_discharge",
  "river_discharge_median",
  "river_discharge_max",
  "river_discharge_p75",
];

export const HAZARD_CATALOG: Record<Hazard, HazardDefinition> = {
  river_flood: {
    hazard: "river_flood",
    description: "River overflow",
    apis: ["flood"],
    screeningVariables: ["river_discharge"],
    currentVariables: [],
    currentHourlyVariables: [],
    tripwireVariables: [],
    indicatorRule:
      "WB flood exposure share when available, otherwise 99th-percentile river discharge (m3/s)",
    primaryThreshold: 1000,
    dormantThreshold: 20,
  },
  flash_flood: {
    hazard: "flash_flood",
    description: "Urban / heavy-rain flooding",
    apis: ["elevation", "archive", "forecast"],
    screeningVariables: ["precipitation_sum", "precipitation_hours"],
    currentVariables: ["precipitation_hours", "precipitation_probability_max"],
    currentHourlyVariables: [],
    tripwireVariables: ["precipitation_sum"],
    indicatorRule: `Days per year with rain >= ${LIMITS.heavyRainMm} mm`,
    primaryThreshold: 3,
    dormantThreshold: 0.5,
  },
  heat: {
    hazard: "heat",
    description: "Extreme and humid heat",
    apis: ["archive", "climate", "forecast"],
    screeningVariables: ["temperature_2m_max", "apparent_temperature_max"],
    currentVariables: ["apparent_temperature_max"],
    currentHourlyVariables: [],
    tripwireVariables: ["temperature_2m_max"],
    indicatorRule: `Days per year with max temperature > ${LIMITS.heatC} C`,
    primaryThreshold: 20,
    dormantThreshold: 2,
  },
  drought: {
    hazard: "drought",
    description: "Rainfall deficit / water stress",
    apis: ["archive", "climate", "forecast"],
    screeningVariables: ["precipitation_sum", "et0_fao_evapotranspiration"],
    currentVariables: ["et0_fao_evapotranspiration"],
    currentHourlyVariables: ["soil_moisture_9_to_27cm"],
    tripwireVariables: [],
    indicatorRule: "Share of years with Jun-Sep rain < 75% of normal",
    primaryThreshold: 1 / 4,
    dormantThreshold: 1 / 15,
  },
  storm: {
    hazard: "storm",
    description: "Cyclone / strong wind",
    apis: ["archive", "forecast"],
    screeningVariables: ["wind_gusts_10m_max", "wind_speed_10m_max"],
    currentVariables: ["wind_gusts_10m_max", "wind_speed_10m_max"],
    currentHourlyVariables: [],
    tripwireVariables: [],
    indicatorRule: `Days per year with gusts > ${LIMITS.gustKmh} km/h`,
    primaryThreshold: 5,
    dormantThreshold: 0.5,
  },
  cold_wave: {
    hazard: "cold_wave",
    description: "Extreme cold (north India)",
    apis: ["archive", "forecast"],
    screeningVariables: ["temperature_2m_min"],
    currentVariables: ["temperature_2m_min"],
    currentHourlyVariables: [],
    tripwireVariables: [],
    indicatorRule: `Days per year with min temperature < ${LIMITS.coldC} C`,
    primaryThreshold: 5,
    dormantThreshold: 0.5,
  },
};

// Tripwire variables are always requested; a dormant hazard contributes
// nothing else. Sorted so the same relevance always gives the same request.
export function forecastVariables(relevance: Record<Hazard, Relevance>): {
  daily: string[];
  hourly: string[];
} {
  const daily = new Set(TRIPWIRE_VARIABLES);
  const hourly = new Set<string>();
  for (const definition of Object.values(HAZARD_CATALOG)) {
    if (relevance[definition.hazard] === "dormant") continue;
    for (const variable of definition.currentVariables) daily.add(variable);
    for (const variable of definition.currentHourlyVariables) hourly.add(variable);
  }
  return { daily: [...daily].sort(), hourly: [...hourly].sort() };
}
