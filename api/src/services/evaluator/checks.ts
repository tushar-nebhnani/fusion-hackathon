import { climateProfileSchema, type ClimateProfile } from "../climate/schema.js";
import { FINANCE } from "../finance/config.js";
import { financeProfileSchema, type FinanceProfile } from "../finance/profile/schema.js";
import { EVALUATOR } from "./config.js";
import type { Check } from "./schema.js";

// What the evaluator got back from the two units
export type ClimateResult = { status: "ok"; profile: ClimateProfile } | { status: "unavailable"; error: string };

export type FinanceResult =
  | { status: "ok"; profile: FinanceProfile }
  // The business is not in the input service (a demo business)
  | { status: "not_applicable" }
  | { status: "unavailable"; error: string };

export interface CheckInput {
  climate: ClimateResult;
  finance: FinanceResult;
  // The business's newest snapshot version, when the input service knows it
  latestSnapshotVersion: number | null;
  now: Date;
}

const HOUR_MS = 3_600_000;

// The forecast run a climate profile came from, as the finance profile names it
export function climateRunRef(profile: ClimateProfile): string {
  const run = profile.data_freshness.forecast_issued_at ?? profile.data_freshness.history_until ?? "";
  return `${profile.location.cells.forecast}@${run}`;
}

function climateChecks(climate: ClimateResult, now: Date): Check[] {
  if (climate.status !== "ok") {
    return [
      { id: "climate_available", status: "fail", detail: `Climate profile unavailable: ${climate.error}` },
      { id: "climate_schema", status: "skip", detail: "No climate profile" },
      { id: "climate_confidence", status: "skip", detail: "No climate profile" },
      { id: "forecast_fresh", status: "skip", detail: "No climate profile" },
    ];
  }
  const { profile } = climate;
  const parsed = climateProfileSchema.safeParse(profile);
  const issued = profile.data_freshness.forecast_issued_at;
  const ageHours = issued ? (now.getTime() - Date.parse(issued)) / HOUR_MS : null;
  return [
    { id: "climate_available", status: "pass", detail: `Grade ${profile.grade} at ${profile.location.cells.forecast}` },
    parsed.success
      ? { id: "climate_schema", status: "pass", detail: "Matches the climate profile schema" }
      : {
          id: "climate_schema",
          status: "fail",
          detail: `Does not match the climate profile schema at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`,
        },
    profile.confidence === "low"
      ? { id: "climate_confidence", status: "warn", detail: "The climate unit's confidence is low" }
      : { id: "climate_confidence", status: "pass", detail: `Confidence ${profile.confidence}` },
    ageHours === null || Number.isNaN(ageHours)
      ? { id: "forecast_fresh", status: "warn", detail: "No forecast run in the profile; scores use history only" }
      : ageHours > EVALUATOR.forecastMaxAgeHours
        ? { id: "forecast_fresh", status: "warn", detail: `Forecast is ${Math.round(ageHours)} hours old` }
        : { id: "forecast_fresh", status: "pass", detail: `Forecast is ${Math.max(0, Math.round(ageHours))} hours old` },
  ];
}

function financeChecks(input: CheckInput): Check[] {
  const { finance, climate, latestSnapshotVersion } = input;
  const ids = [
    "finance_schema",
    "finance_current",
    "snapshot_verified",
    "same_location",
    "same_climate_run",
    "stress_coverage",
    "adjustment_cap",
  ] as const;
  if (finance.status !== "ok") {
    const why = finance.status === "not_applicable" ? "Not a business of the input service" : "No finance profile";
    return [
      finance.status === "not_applicable"
        ? { id: "finance_available", status: "skip", detail: why }
        : { id: "finance_available", status: "fail", detail: `Finance profile unavailable: ${finance.error}` },
      ...ids.map((id): Check => ({ id, status: "skip", detail: why })),
    ];
  }

  const { profile } = finance;
  const parsed = financeProfileSchema.safeParse(profile);
  const checks: Check[] = [
    { id: "finance_available", status: "pass", detail: `Baseline score ${profile.baseline.score}` },
    parsed.success
      ? { id: "finance_schema", status: "pass", detail: "Matches the finance profile schema" }
      : {
          id: "finance_schema",
          status: "fail",
          detail: `Does not match the finance profile schema at ${parsed.error.issues[0]?.path.join(".") ?? "?"}`,
        },
  ];

  const version = profile.inputs.snapshot_version;
  checks.push(
    latestSnapshotVersion === null
      ? { id: "finance_current", status: "skip", detail: "Latest snapshot unknown" }
      : version === latestSnapshotVersion
        ? { id: "finance_current", status: "pass", detail: `Built from the latest snapshot, v${version}` }
        : {
            id: "finance_current",
            status: "fail",
            detail: `Built from snapshot v${version}, but the latest is v${latestSnapshotVersion}`,
          },
    profile.inputs.snapshot_verified
      ? { id: "snapshot_verified", status: "pass", detail: "Snapshot verified by the bank" }
      : { id: "snapshot_verified", status: "warn", detail: "Snapshot not yet verified by the bank" },
  );

  const ref = profile.climate;
  if (climate.status !== "ok") {
    checks.push(
      { id: "same_location", status: "skip", detail: "No climate profile to compare with" },
      { id: "same_climate_run", status: "skip", detail: "No climate profile to compare with" },
    );
  } else if (!ref) {
    checks.push(
      { id: "same_location", status: "warn", detail: "The finance profile has no climate adjustment" },
      { id: "same_climate_run", status: "skip", detail: "The finance profile has no climate adjustment" },
    );
  } else {
    const cell = climate.profile.location.cells.forecast;
    checks.push(
      ref.cell_id === cell
        ? { id: "same_location", status: "pass", detail: `Both use cell ${cell}` }
        : { id: "same_location", status: "fail", detail: `Finance used cell ${ref.cell_id}, climate is for ${cell}` },
      ref.profile_ref === climateRunRef(climate.profile)
        ? { id: "same_climate_run", status: "pass", detail: "Both use the same forecast run" }
        : {
            id: "same_climate_run",
            status: "warn",
            detail: `Finance was stress-tested on ${ref.profile_ref}; the forecast has been refreshed since (grade then ${ref.grade}, now ${climate.profile.grade})`,
          },
    );
  }

  checks.push(
    climate.status === "ok" && Object.keys(profile.stress).length === 0
      ? { id: "stress_coverage", status: "warn", detail: "No hazard was stress-tested" }
      : { id: "stress_coverage", status: "pass", detail: `${Object.keys(profile.stress).length} hazards stress-tested` },
  );

  const adjusted = profile.adjusted;
  const ceiling = profile.baseline.score + FINANCE.adjusted.maxUplift;
  checks.push(
    !adjusted
      ? { id: "adjustment_cap", status: "skip", detail: "No adjusted score" }
      : adjusted.score > ceiling
        ? {
            id: "adjustment_cap",
            status: "fail",
            detail: `Adjusted score ${adjusted.score} is above the baseline plus ${FINANCE.adjusted.maxUplift}`,
          }
        : { id: "adjustment_cap", status: "pass", detail: `Adjusted ${adjusted.score}, baseline ${profile.baseline.score}` },
  );
  return checks;
}

export function runChecks(input: CheckInput): Check[] {
  return [...climateChecks(input.climate, input.now), ...financeChecks(input)];
}
