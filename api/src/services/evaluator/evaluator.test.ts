import { describe, expect, it } from "vitest";
import type { FinanceProfile } from "../finance/profile/schema.js";
import { climateProfile } from "../finance/testing/fixtures.js";
import { runChecks } from "./checks.js";
import { EVALUATOR } from "./config.js";
import { combinedRating, reasons } from "./rating.js";
import type { Check } from "./schema.js";
import { createEvaluatorService } from "./service.js";

const NOW = new Date("2026-10-09T06:00:00Z");
const pass: Check[] = [{ id: "climate_available", status: "pass", detail: "ok" }];

// Only the fields the rating reads
function finance(
  band: FinanceProfile["baseline"]["band"],
  options: { adjusted?: FinanceProfile["baseline"]["band"]; breach?: boolean } = {},
): FinanceProfile {
  return {
    baseline: { score: 70, band },
    adjusted: options.adjusted ? { score: 60, band: options.adjusted, drivers: [] } : null,
    stress: options.breach ? { river_flood: { breach: true } } : {},
  } as unknown as FinanceProfile;
}

describe("combined rating", () => {
  it("reads the finance band and the climate grade off the table", () => {
    const climate = climateProfile();
    expect(climate.grade).toBe("C");
    expect(combinedRating(pass, climate, finance("low_risk"))).toBe(EVALUATOR.rating.low_risk.C);
    expect(combinedRating(pass, climate, finance("high"))).toBe("unfavourable");
    expect(combinedRating(pass, { ...climate, grade: "A" }, finance("moderate"))).toBe("acceptable");
  });

  it("uses the climate-adjusted band when there is one", () => {
    expect(combinedRating(pass, climateProfile(), finance("low_risk", { adjusted: "critical" }))).toBe("unfavourable");
  });

  it("is never better than caution when a stress test breached", () => {
    expect(combinedRating(pass, { ...climateProfile(), grade: "A" }, finance("low_risk", { breach: true }))).toBe(
      "caution",
    );
    expect(combinedRating(pass, climateProfile(), finance("critical", { breach: true }))).toBe("unfavourable");
  });

  it("gives insufficient_data on a failed check or a missing side", () => {
    const failed: Check[] = [{ id: "same_location", status: "fail", detail: "other cell" }];
    expect(combinedRating(failed, climateProfile(), finance("low_risk"))).toBe("insufficient_data");
    expect(combinedRating(pass, null, finance("low_risk"))).toBe("insufficient_data");
    expect(combinedRating(pass, climateProfile(), null)).toBe("insufficient_data");
  });

  it("puts a failed check first in the reasons", () => {
    const failed: Check[] = [{ id: "same_location", status: "fail", detail: "other cell" }];
    expect(reasons(failed, climateProfile(), null)[0]).toBe("Not reliable: other cell.");
  });
});

describe("checks", () => {
  it("skips the finance checks for a business the finance service does not know", () => {
    const checks = runChecks({
      climate: { status: "ok", profile: climateProfile() },
      finance: { status: "not_applicable" },
      latestSnapshotVersion: null,
      now: NOW,
    });
    expect(checks.filter((c) => c.id.startsWith("finance") || c.id === "same_location").map((c) => c.status)).toEqual([
      "skip",
      "skip",
      "skip",
      "skip",
    ]);
    expect(checks.some((c) => c.status === "fail")).toBe(false);
  });

  it("fails a climate profile that breaks its schema", () => {
    const broken = { ...climateProfile(), grade: "Z" } as unknown as ReturnType<typeof climateProfile>;
    const checks = runChecks({ climate: { status: "ok", profile: broken }, finance: { status: "not_applicable" }, latestSnapshotVersion: null, now: NOW });
    expect(checks.find((c) => c.id === "climate_schema")?.status).toBe("fail");
  });

  it("flags a stale forecast", () => {
    const later = new Date(NOW.getTime() + (EVALUATOR.forecastMaxAgeHours + 10) * 3_600_000);
    const checks = runChecks({ climate: { status: "ok", profile: climateProfile() }, finance: { status: "not_applicable" }, latestSnapshotVersion: null, now: later });
    expect(checks.find((c) => c.id === "forecast_fresh")?.status).toBe("warn");
  });
});

describe("evaluator without the input and finance services", () => {
  it("evaluates the climate side at the given point, and needs one", async () => {
    const evaluator = createEvaluatorService({
      climate: { getProfile: () => Promise.resolve(climateProfile()) },
      now: () => NOW,
      logger: { error: () => undefined, warn: () => undefined },
    });

    const evaluation = await evaluator.evaluate({ businessId: "SME-0101", point: { lat: 19.07, lon: 72.87 } });

    expect(evaluation).toMatchObject({ evaluation_id: null, reliable: true, rating: "insufficient_data", finance: null });
    await expect(evaluator.evaluate({ businessId: "SME-0101" })).rejects.toMatchObject({ statusCode: 404 });
  });
});
