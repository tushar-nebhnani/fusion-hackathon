import { describe, expect, it, vi } from "vitest";
import { FINANCE } from "../config.js";
import { computeMetrics } from "../metrics/compute.js";
import { financeInputs, sensitivity } from "../testing/fixtures.js";
import { adjustScore } from "./adjusted.js";
import { bandScore, baselineScore, riskBand, subScores } from "./baseline.js";
import { chooseScorer, createMlScorer, rulesScorer } from "./scorer.js";
import { stressHazard, type StressContext } from "./stress.js";

const metrics = computeMetrics(financeInputs());
const context: StressContext = { sector: "retail", insuranceCovers: [] };
const { bands } = FINANCE.baseline;

describe("baseline score", () => {
  it("weights sum to 1", () => {
    const total = Object.values(FINANCE.baseline.weights).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("returns the sub-scores with the total", () => {
    expect(baselineScore(metrics)).toEqual({
      // 0.3*100 + 0.2*85 + 0.15*85 + 0.1*80 + 0.15*100 + 0.1*80 = 90.75
      score: 91,
      band: "low_risk",
      sub_scores: { dscr: 100, runway: 85, leverage: 85, volatility: 80, repayment: 100, business_age: 80 },
      source: "rules",
    });
  });

  it.each([
    [70, "low_risk"],
    [69, "moderate"],
    [50, "moderate"],
    [49, "high"],
    [30, "high"],
    [29, "critical"],
    [0, "critical"],
  ])("puts a score of %i in the %s band", (score, band) => {
    expect(riskBand(score)).toBe(band);
  });

  it.each([
    [2, 100],
    [1.99, 85],
    [1.5, 85],
    [1.25, 70],
    [1, 45],
    [0.99, 20],
    [0.75, 20],
    [0.74, 0],
    [-0.5, 0],
  ])("scores a DSCR of %f as %i", (dscr, score) => {
    expect(bandScore(bands.dscr, dscr)).toBe(score);
  });

  it.each([
    [0.1, 100],
    [0.11, 85],
    [0.5, 65],
    [1, 35],
    [2, 15],
    [2.01, 0],
  ])("scores a leverage of %f as %i", (leverage, score) => {
    expect(bandScore(bands.leverage, leverage)).toBe(score);
  });

  it("scores the runway, volatility, repayment and age boundaries", () => {
    expect([12, 6, 3, 1, 0.9].map((months) => bandScore(bands.runway, months))).toEqual([70, 50, 30, 10, 0]);
    expect([0.1, 0.2, 0.35, 0.5, 0.51].map((cv) => bandScore(bands.volatility, cv))).toEqual([
      100, 80, 60, 35, 10,
    ]);
    expect([0, 1, 2, 4, 5].map((missed) => bandScore(bands.repayment, missed))).toEqual([100, 75, 50, 25, 0]);
    expect([10, 5, 3, 1, 0].map((years) => bandScore(bands.business_age, years))).toEqual([
      100, 80, 60, 35, 15,
    ]);
  });

  it("treats no debt as the best DSCR", () => {
    expect(subScores({ ...metrics, dscr: null }).dscr).toBe(100);
  });

  it("scores a business that is not burning cash on its cash buffer", () => {
    const runway = (buffer: number | null) =>
      subScores({ ...metrics, cash_runway_months: null, cash_buffer_months: buffer }).runway;

    expect([3, 2.9, 1, 0.9, 0].map(runway)).toEqual([100, 85, 85, 70, 70]);
    // No costs and no repayments: nothing for the cash to cover
    expect(runway(null)).toBe(100);
    // A thin buffer still beats the best score of a business burning cash
    expect(runway(0)).toBeGreaterThanOrEqual(subScores({ ...metrics, cash_runway_months: 24 }).runway);
  });

  it("puts a loss-making, indebted business in the critical band", () => {
    const weak = computeMetrics(
      financeInputs({
        monthly_expenses: 110_000,
        outstanding_debt: 3_000_000,
        missed_payments_12m: 6,
        years_in_operation: 0,
      }),
    );

    // Runway of 3 months scores 30, volatility 80, age 15; the rest score 0
    expect(baselineScore(weak)).toMatchObject({ score: 16, band: "critical" });
  });
});

describe("scorer", () => {
  it("uses the rules by default", async () => {
    expect(await rulesScorer.score(metrics)).toEqual({ result: baselineScore(metrics), fallback: null });
    expect(chooseScorer({ scorer: "rules", mlUrl: null }).name).toBe("rules");
    // The flag alone is not enough: there is nowhere to send the metrics
    expect(chooseScorer({ scorer: "ml", mlUrl: null }).name).toBe("rules");
    expect(chooseScorer({ scorer: "ml", mlUrl: "http://ml.test/score" }).name).toBe("ml");
  });

  it("takes the score from the model and the band from our thresholds", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ score: 61.4 })));
    const scorer = createMlScorer({ url: "http://ml.test/score", fetch: fetchFn });

    const outcome = await scorer.score(metrics);

    expect(outcome).toEqual({
      result: { score: 61, band: "moderate", sub_scores: baselineScore(metrics).sub_scores, source: "ml" },
      fallback: null,
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://ml.test/score");
    expect(JSON.parse(init?.body as string)).toEqual({ model_version: FINANCE.modelVersion, metrics });
  });

  it.each([
    ["the call fails", () => Promise.reject(new Error("connection refused")), "connection refused"],
    ["the model answers with an error", () => Promise.resolve(new Response("", { status: 503 })), "HTTP 503"],
    ["the score is out of range", () => Promise.resolve(Response.json({ score: 140 })), "Too big"],
  ])("falls back to the rules when %s", async (_case, reply, reason) => {
    const scorer = createMlScorer({ url: "http://ml.test/score", fetch: vi.fn<typeof fetch>(reply) });

    const outcome = await scorer.score(metrics);

    expect(outcome.result).toEqual(baselineScore(metrics));
    expect(outcome.fallback).toContain("ml_scorer_failed");
    expect(outcome.fallback).toContain(reason);
  });
});

describe("adjusted score", () => {
  const baseline = baselineScore(metrics);
  const flood = stressHazard(metrics, "river_flood", 0.5, sensitivity(), context);

  it("takes a penalty in proportion to how far the stressed metrics fall", () => {
    const adjusted = adjustScore(baseline, metrics, { river_flood: flood });

    // 20 points x 30% of revenue = 6, plus 0.6 x the 37 point fall of the
    // re-scored business (91 to 54) = 22.2
    expect(adjusted).toEqual({
      score: 63,
      band: "moderate",
      drivers: [
        {
          hazard: "river_flood",
          points_change: -28.2,
          reason:
            "River flood stress (severity 0.5, revenue down 30%) drops DSCR from 2 to 0.5, leaving 9 months of cash",
        },
      ],
    });
  });

  it("counts each further hazard for less and orders drivers by impact", () => {
    const storm = stressHazard(metrics, "storm", 0.25, sensitivity(), context);

    const adjusted = adjustScore(baseline, metrics, { storm, river_flood: flood });

    expect(adjusted.drivers.map((driver) => driver.hazard)).toEqual(["river_flood", "storm"]);
    // Storm: 20 x 15% = 3, DSCR 2 to 1.25 costs 0.6 x 9 = 5.4; halved as the second hazard
    expect(adjusted.drivers[1]?.points_change).toBe(-4.2);
    expect(adjusted.score).toBe(59);
  });

  it("never lifts the score more than the cap above the baseline", () => {
    const good = sensitivity({ direction: "favourable", magnitude: 0.5, physical: 0, demand: 0.5 });
    const stress = {
      heat: stressHazard(metrics, "heat", 1, good, context),
      drought: stressHazard(metrics, "drought", 1, good, context),
      storm: stressHazard(metrics, "storm", 1, good, context),
    };

    const adjusted = adjustScore(baseline, metrics, stress);

    // Three gains of 2 points each are scaled down to 3 in all
    expect(adjusted.score).toBe(baseline.score + FINANCE.adjusted.maxUplift);
    expect(adjusted.drivers.map((driver) => driver.points_change)).toEqual([1, 1, 1]);
    expect(adjusted.drivers[0]?.reason).toBe("Heat conditions (severity 1) lift revenue by 10%");
  });

  it("does not let good weather rescue a weak business", () => {
    const weak = computeMetrics(financeInputs({ monthly_expenses: 95_000, missed_payments_12m: 5 }));
    const weakBaseline = baselineScore(weak);
    const good = sensitivity({ direction: "favourable", magnitude: 1, physical: 0, demand: 1 });

    const adjusted = adjustScore(weakBaseline, weak, { heat: stressHazard(weak, "heat", 1, good, context) });

    expect(weakBaseline.band).toBe("high");
    expect(adjusted.score - weakBaseline.score).toBe(2);
    expect(adjusted.band).toBe("high");
  });

  it("leaves the baseline alone and lists no driver when nothing moves", () => {
    const calm = stressHazard(metrics, "cold_wave", 0.9, sensitivity({ direction: "neutral", magnitude: 0 }), context);

    expect(adjustScore(baseline, metrics, { cold_wave: calm })).toEqual({
      score: baseline.score,
      band: baseline.band,
      drivers: [],
    });
  });

  it("describes the cashflow when the business has no debt", () => {
    const debtFree = computeMetrics(financeInputs({ existing_emi: 0, outstanding_debt: 0 }));
    const stress = stressHazard(debtFree, "drought", 0.5, sensitivity(), context);

    const adjusted = adjustScore(baselineScore(debtFree), debtFree, { drought: stress });

    expect(adjusted.drivers[0]?.reason).toBe(
      "Drought stress (severity 0.5, revenue down 30%) cuts monthly cashflow from ₹40,000 to ₹10,000",
    );
  });

  it("never goes below zero", () => {
    const weak = computeMetrics(financeInputs({ monthly_expenses: 110_000, missed_payments_12m: 9 }));
    const all = sensitivity({ magnitude: 1, physical: 1, demand: 0 });

    const adjusted = adjustScore({ ...baselineScore(weak), score: 4 }, weak, {
      river_flood: stressHazard(weak, "river_flood", 1, all, context),
    });

    expect(adjusted.score).toBe(0);
  });
});
