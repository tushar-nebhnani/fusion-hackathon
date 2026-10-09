// Climate tool configuration (README section 17). Thresholds and weights are
// starting assumptions, to be tuned once real values are observed.
export const CLIMATE = {
  grid: { historical: 0.1, climate: 0.1, flood: 0.05, forecast: 0.1 },
  timezone: "Asia/Kolkata",
  historyStart: "1995-01-01",
  era5DelayDays: 5,
  forecastDays: 7,
  forecastPastDays: 5,
  floodForecastDays: 30,
  floodForecastPastDays: 7,
  climateModels: ["EC_Earth3P_HR", "MRI_AGCM3_2_S"],
  projectionBaseline: { start: "1995-01-01", end: "2014-12-31" },
  projectionFuture: { start: "2026-01-01", end: "2045-12-31" },
  staleForecastHours: 6,
  staleFloodHours: 24,
  rescreenDays: 90,
  // A profile screened with a source missing is retried sooner
  degradedRescreenDays: 1,
  // Wait before asking again for projections that could not be fetched
  projectionRetryMinutes: 5,
  scoreWeights: { structural: 0.3, historical: 0.5, forecast: 0.2 },
  relevanceWeights: { primary: 1, secondary: 0.5, dormant: 0.1 },
  maxProjectionAdjustment: 0.1,
  // Demo coverage: India's bounding box
  coverageBbox: { latMin: 6, latMax: 37, lonMin: 68, lonMax: 98 },
  // Forecast skill drops after ~7 days, so events are only raised inside it
  eventWindowDays: 7,
  // Distance to the 8 neighbours used for relative elevation (~1 km)
  elevationNeighbourDeg: 0.009,
  ruleVersion: "static-1",
  modelVersion: "score-1",
  staticSourceVersion: "copernicus-dem-glo90",
  upstream: {
    attempts: 3,
    backoffMs: 500,
    timeoutMs: 15_000,
    historyTimeoutMs: 60_000,
  },
} as const;
