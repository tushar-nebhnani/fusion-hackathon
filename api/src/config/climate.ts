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
  // Fetched forecasts are cached this long; past it they are refetched,
  // never served
  staleForecastHours: 6,
  staleFloodHours: 6,
  // Background job: forecast layers of every known location are refetched
  refreshHours: 6,
  rescreenDays: 90,
  // A profile screened with a source missing is retried sooner
  degradedRescreenDays: 1,
  // Wait before asking again for projections that could not be fetched
  projectionRetryMinutes: 5,
  agent: {
    // Part of `agent_version`; bump when a prompt in src/prompts/climate.ts changes
    promptVersion: "agent-1",
    maxTokens: 16_000,
    timeoutMs: 90_000,
    maxRetries: 2,
    // After a failed call the agent is left alone for this long
    retryMinutes: 5,
  },
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
  // Background monitor (services/climate/monitor). It runs as its own
  // process; MONITOR_* in .env overrides the first three values.
  monitor: {
    tickMinutes: 15,
    // Cells checked at once, so the monitor cannot flood Open-Meteo
    concurrency: 5,
    // Hours between two checks of a cell, by its level
    intervalHours: { NORMAL: 6, WATCH: 3, WARNING: 1, SEVERE: 1 },
    // Calm checks in a row before a cell steps down one level
    calmRunsToStepDown: 2,
    entryTimeoutMs: 15_000,
    // A cell's first check may have to screen ~30 years of history
    firstCheckTimeoutMs: 90_000,
    agentTimeoutMs: 20_000,
    // The agent reviews a cell at most this often
    agentReviewHours: 6,
    // A claimed cell is handed back if its monitor dies for this long
    leaseSeconds: 300,
    // IMD daily rainfall classes (mm): heavy, very heavy, extremely heavy.
    // Rain below `minProbabilityPct` does not count.
    rain: { minProbabilityPct: 25, heavyMm: 64.5, veryHeavyMm: 115.6, extremelyHeavyMm: 204.5 },
    // River above its historical high plus heavy rain this soon is SEVERE
    riverRainWithinHours: 72,
    // Least level of a dormant hazard whose tripwire trips
    dormantTripLevel: "WARNING",
    // Agent forecast score (0-1) from which it may raise a hazard to a level.
    // It cannot raise to SEVERE: that needs measured values.
    agentLevels: { watch: 0.6, warning: 0.85 },
    verify: {
      // Days of observed data scanned for extremes nobody forecast
      scanDays: 7,
      // An observed extreme this close to an event's window counts as forecast
      matchToleranceDays: 2,
    },
  },
} as const;
