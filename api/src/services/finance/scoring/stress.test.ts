import { describe, expect, it } from "vitest";
import { HAZARDS } from "../../climate/types.js";
import { fallbackConditions } from "../../input/classifier/defaults.js";
import { validReply } from "../../input/testing/fixtures.js";
import { FINANCE } from "../config.js";
import { computeMetrics } from "../metrics/compute.js";
import { financeInputs, sensitivity } from "../testing/fixtures.js";
import { revenueEffect, toSensitivities } from "./sensitivity.js";
import { matchingCovers, revenueShock, stressHazard, stressTest, type StressContext } from "./stress.js";

const metrics = computeMetrics(financeInputs());
const uninsured: StressContext = { sector: "retail", insuranceCovers: [] };

describe("sensitivity", () => {
  it("combines the physical and the demand effect into one revenue effect", () => {
    expect(revenueEffect(0.5, -0.2)).toBeCloseTo(-0.6, 10);
    expect(revenueEffect(0.2, 0.7)).toBeCloseTo(0.36, 10);
    expect(revenueEffect(1, 1)).toBe(-1);
    expect(revenueEffect(0, 0)).toBe(0);
  });

  it("reads direction, magnitude and channels from a classifier profile", () => {
    const conditions = Object.fromEntries(
      Object.entries(validReply().conditions).map(([hazard, condition]) => [
        hazard,
        { ...condition, source: "llm" as const },
      ]),
    ) as Parameters<typeof toSensitivities>[0];

    const hazards = toSensitivities(conditions);

    expect(hazards.heat).toEqual({
      direction: "favourable",
      magnitude: 0.36,
      channels: ["revenue"],
      reason: "test reason",
      physical: 0.2,
      demand: 0.7,
    });
    expect(hazards.river_flood).toMatchObject({ direction: "unfavourable", magnitude: 0.86 });
  });

  it("forces a neutral hazard's magnitude to zero", () => {
    const conditions = fallbackConditions("retail", "test");
    conditions.drought = { ...conditions.drought, physical: 0.01, demand: 0 };

    expect(toSensitivities(conditions).drought).toMatchObject({
      direction: "neutral",
      magnitude: 0,
      channels: [],
    });
  });

  it("keeps every magnitude between 0 and 1 for every sector default", () => {
    const hazards = toSensitivities(fallbackConditions("agriculture", "test"));

    for (const hazard of HAZARDS) {
      expect(hazards[hazard].magnitude).toBeGreaterThanOrEqual(0);
      expect(hazards[hazard].magnitude).toBeLessThanOrEqual(1);
      expect(hazards[hazard].direction).toBe("unfavourable");
    }
  });
});

describe("revenue shock", () => {
  it("is severity times magnitude, as a loss, for an unfavourable hazard", () => {
    const { gross, shock } = revenueShock(0.5, sensitivity(), false);

    expect(gross).toBeCloseTo(-0.3, 10);
    expect(shock).toBeCloseTo(-0.3, 10);
  });

  it("caps a favourable gain", () => {
    const good = sensitivity({ direction: "favourable", magnitude: 0.5, physical: 0, demand: 0.5 });

    expect(revenueShock(0.8, good, false)).toEqual({ gross: 0.4, shock: FINANCE.stress.favourableCap });
    // Below the cap the gain is kept as it is
    expect(revenueShock(0.1, good, false).shock).toBeCloseTo(0.05, 10);
    // Insurance has nothing to pay on a gain
    expect(revenueShock(0.8, good, true).shock).toBe(FINANCE.stress.favourableCap);
  });

  it("is zero for a neutral hazard whatever the severity", () => {
    expect(revenueShock(1, sensitivity({ direction: "neutral", magnitude: 0 }), true).shock).toBe(0);
  });

  it("takes insurance off the physical part of a loss only", () => {
    // physical 0.5 against lost demand 0.2: 5/7 of the loss is insurable,
    // and half of that is covered
    expect(revenueShock(0.5, sensitivity(), true).shock).toBeCloseTo(-0.3 * (1 - 0.5 * (5 / 7)), 10);
    // A loss that is all lost demand is not insurable at all
    const demandOnly = sensitivity({ magnitude: 0.4, physical: 0, demand: -0.4 });
    expect(revenueShock(0.5, demandOnly, true).shock).toBeCloseTo(-0.2, 10);
  });

  it("clamps the severity to 0-1", () => {
    expect(revenueShock(1.4, sensitivity(), false).shock).toBeCloseTo(-0.6, 10);
    expect(revenueShock(-1, sensitivity(), false).shock).toBe(0);
  });
});

describe("insurance cover matching", () => {
  it("matches a cover to the hazards it answers for", () => {
    const insured: StressContext = { sector: "retail", insuranceCovers: ["flood", "stock", "fire"] };

    expect(matchingCovers("river_flood", insured)).toEqual(["flood", "stock"]);
    expect(matchingCovers("storm", insured)).toEqual(["stock"]);
    expect(matchingCovers("heat", insured)).toEqual([]);
  });

  it("applies crop cover to a farm and not to a shop", () => {
    expect(matchingCovers("drought", { sector: "agriculture", insuranceCovers: ["crop"] })).toEqual(["crop"]);
    expect(matchingCovers("drought", { sector: "retail", insuranceCovers: ["crop"] })).toEqual([]);
  });
});

describe("stressHazard", () => {
  it("recomputes cashflow, DSCR and runway under the stressed revenue", () => {
    expect(stressHazard(metrics, "river_flood", 0.5, sensitivity(), uninsured)).toEqual({
      severity: 0.5,
      direction: "unfavourable",
      shock_pct: -30,
      gross_shock_pct: -30,
      insurance_applied: [],
      duration_months: 2,
      stressed_metrics: {
        monthly_revenue: 70_000,
        net_monthly_cashflow: 10_000,
        dscr: 0.5,
        surplus_after_debt: -10_000,
        cash_runway: "burning",
        cash_runway_months: 9,
        // 90,000 less two months of a 10,000 burn
        cash_after_shock: 70_000,
      },
      breach: true,
      breach_reasons: ["dscr_below_1"],
    });
  });

  it("softens the shock for an insured business", () => {
    const insured: StressContext = { sector: "retail", insuranceCovers: ["flood"] };

    const result = stressHazard(metrics, "river_flood", 0.5, sensitivity(), insured);

    expect(result).toMatchObject({ shock_pct: -19.29, gross_shock_pct: -30, insurance_applied: ["flood"] });
    expect(result.stressed_metrics.dscr).toBe(1.0357);
    expect(result.breach).toBe(false);
  });

  it("breaches on runway when the cash would last under three months", () => {
    const thin = computeMetrics(financeInputs({ cash_reserves: 20_000 }));

    const result = stressHazard(thin, "storm", 0.5, sensitivity(), {
      ...uninsured,
      durationMonths: 4,
    });

    expect(result.stressed_metrics).toMatchObject({ cash_runway_months: 2, cash_after_shock: -20_000 });
    expect(result.duration_months).toBe(4);
    expect(result.breach_reasons).toEqual(["dscr_below_1", "runway_below_3_months"]);
  });

  it("does not breach while the stressed business still covers its debt", () => {
    const result = stressHazard(metrics, "heat", 0.2, sensitivity(), uninsured);

    expect(result.shock_pct).toBe(-12);
    expect(result.stressed_metrics).toMatchObject({ dscr: 1.4, cash_runway_months: null, cash_after_shock: 90_000 });
    expect(result.breach).toBe(false);
  });

  it("lifts revenue by the capped gain for a favourable hazard", () => {
    const good = sensitivity({ direction: "favourable", magnitude: 0.5, physical: 0, demand: 0.5 });

    const result = stressHazard(metrics, "heat", 0.8, good, uninsured);

    expect(result).toMatchObject({ direction: "favourable", shock_pct: 10, gross_shock_pct: 40 });
    expect(result.stressed_metrics.monthly_revenue).toBe(110_000);
  });

  it("never breaches on DSCR for a business with no debt", () => {
    const debtFree = computeMetrics(financeInputs({ existing_emi: 0, outstanding_debt: 0 }));

    const result = stressHazard(debtFree, "river_flood", 1, sensitivity(), uninsured);

    expect(result.stressed_metrics.dscr).toBeNull();
    expect(result.breach).toBe(false);
  });
});

describe("stressTest", () => {
  it("returns one result per climate hazard", () => {
    const severities = { river_flood: 0.9, flash_flood: 0.5, heat: 0.3, drought: 0, storm: 0.2, cold_wave: 0 };

    const results = stressTest(metrics, severities, toSensitivities(fallbackConditions("retail", "test")), uninsured);

    expect(Object.keys(results).sort()).toEqual([...HAZARDS].sort());
    expect(results.river_flood.shock_pct).toBe(-54);
    expect(results.drought.shock_pct).toBe(0);
  });
});
