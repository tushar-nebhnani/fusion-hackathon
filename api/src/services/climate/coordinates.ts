import { CLIMATE } from "../../config/climate.js";
import { AppError } from "../../errors/app-error.js";
import type { LatLon } from "./types.js";

const STEP = "input_validation";
const NUMERIC_STRING = /^-?\d{1,3}(\.\d{1,10})?$/;

function invalid(status: number, code: string, message: string): AppError {
  return new AppError(message, status, code, undefined, STEP);
}

function toNumber(value: unknown, allowStrings: boolean): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (allowStrings && typeof value === "string" && NUMERIC_STRING.test(value)) {
    return Number(value);
  }
  return null;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

// Validates in the README order: presence, type, range, coverage. Latitude
// always comes first. `allowStrings` is for query-string input only.
export function parseCoordinates(
  rawLat: unknown,
  rawLon: unknown,
  options: { allowStrings?: boolean } = {},
): LatLon {
  if (isMissing(rawLat) || isMissing(rawLon)) {
    throw invalid(400, "MISSING_COORDINATES", "Both lat and lon are required");
  }

  const lat = toNumber(rawLat, options.allowStrings ?? false);
  const lon = toNumber(rawLon, options.allowStrings ?? false);
  if (lat === null || lon === null) {
    throw invalid(400, "INVALID_COORDINATES", "lat and lon must be numbers");
  }

  if (lat < -90 || lat > 90) {
    throw invalid(400, "OUT_OF_RANGE", "Latitude must be between -90 and 90");
  }
  if (lon < -180 || lon > 180) {
    throw invalid(400, "OUT_OF_RANGE", "Longitude must be between -180 and 180");
  }

  const box = CLIMATE.coverageBbox;
  if (lat < box.latMin || lat > box.latMax || lon < box.lonMin || lon > box.lonMax) {
    throw invalid(
      422,
      "OUTSIDE_COVERAGE",
      "Location is outside the supported coverage area (India)",
    );
  }

  // 4 decimal places is about 10 m
  return { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) };
}
