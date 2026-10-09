import { describe, expect, it } from "vitest";
import { AppError } from "../../errors/app-error.js";
import { parseCoordinates } from "./coordinates.js";

function failure(lat: unknown, lon: unknown, options?: { allowStrings?: boolean }) {
  try {
    parseCoordinates(lat, lon, options);
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.statusCode, code: error.code, step: error.step };
    }
    throw error;
  }
  throw new Error("expected parseCoordinates to throw");
}

describe("parseCoordinates", () => {
  it("accepts a point in India and rounds to 4 decimal places", () => {
    expect(parseCoordinates(26.14454321, 91.73621234)).toEqual({ lat: 26.1445, lon: 91.7362 });
  });

  it("accepts numeric strings only when asked to (query strings)", () => {
    expect(parseCoordinates("26.1445", "91.7362", { allowStrings: true })).toEqual({
      lat: 26.1445,
      lon: 91.7362,
    });
    expect(failure("26.1445", "91.7362")).toMatchObject({ code: "INVALID_COORDINATES" });
  });

  it.each([
    [undefined, 91.7],
    [26.1, undefined],
    [null, null],
    ["", ""],
  ])("reports missing coordinates for (%o, %o)", (lat, lon) => {
    expect(failure(lat, lon, { allowStrings: true })).toEqual({
      status: 400,
      code: "MISSING_COORDINATES",
      step: "input_validation",
    });
  });

  it.each([
    ["text", "abc", "91.7"],
    ["NaN", Number.NaN, 91.7],
    ["Infinity", Number.POSITIVE_INFINITY, 91.7],
    ["boolean", true, 91.7],
    ["array", ["26.1"], "91.7"],
    ["object", { $gt: 0 }, 91.7],
    ["hex string", "0x1A", "91.7"],
    ["exponent string", "1e1", "91.7"],
    ["trailing junk", "26.1; DROP TABLE", "91.7"],
  ])("rejects non-numeric input: %s", (_name, lat, lon) => {
    expect(failure(lat, lon, { allowStrings: true })).toMatchObject({
      status: 400,
      code: "INVALID_COORDINATES",
    });
  });

  it.each([
    [95, 80],
    [-91, 80],
    [20, 181],
    [20, -181],
  ])("rejects out-of-range (%d, %d)", (lat, lon) => {
    expect(failure(lat, lon)).toMatchObject({ status: 400, code: "OUT_OF_RANGE" });
  });

  it.each([
    ["Paris", 48.8566, 2.3522],
    ["swapped lat/lon", 91.7362, 26.1445],
    ["just south of the box", 5.9, 80],
  ])("rejects points outside India: %s", (_name, lat, lon) => {
    const result = failure(lat, lon);
    expect(["OUTSIDE_COVERAGE", "OUT_OF_RANGE"]).toContain(result.code);
  });

  it("uses 422 for valid coordinates outside coverage", () => {
    expect(failure(48.8566, 2.3522)).toMatchObject({ status: 422, code: "OUTSIDE_COVERAGE" });
  });
});
