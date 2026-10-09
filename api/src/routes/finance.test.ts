import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { connectDb, disconnectDb, prisma } from "../config/db.js";
import {
  BANK as BANK_USER,
  OTHER_OWNER,
  OWNER,
  cookieFor,
  fakeAuth,
  signedIn,
  userRow,
} from "../services/auth/testing/fake-auth.js";
import type { UpstreamStatus } from "../services/climate/open-meteo.js";
import { createClimateService, type ClimateService } from "../services/climate/profile.service.js";
import { fakeOpenMeteo } from "../services/climate/testing/fake-open-meteo.js";
import { memoryCache } from "../services/climate/testing/memory-cache.js";
import { HAZARDS, type Hazard } from "../services/climate/types.js";
import { DEMO } from "../services/finance/demo.js";
import {
  FINANCE,
  createFinanceService,
  createMlScorer,
  financeProfileSchema,
  type FinanceProfile,
  type FinanceService,
  type LocationEvaluation,
  type RepaymentCapacity,
  type ScenarioResult,
  type Scorer,
} from "../services/finance/index.js";
import { amortisedEmi } from "../services/finance/metrics/compute.js";
import type { HazardStress } from "../services/finance/scoring/stress.js";
import { fakeClimate } from "../services/finance/testing/fixtures.js";
import type { ClassifierLlm } from "../services/input/classifier/index.js";
import { createInputService, type BusinessDetail, type InputService } from "../services/input/service.js";
import type { LoanView } from "../services/input/store.js";
import { businessBody, fakeLlm, financialsBody, loanBody } from "../services/input/testing/fixtures.js";

// Integration tests: the real Express app, Postgres and input service. The
// climate unit is a stand-in, except where a test says otherwise.
const NOW = new Date("2026-10-09T06:00:00Z");
const BANK = { Cookie: cookieFor(BANK_USER) };
const silent = { error: vi.fn(), warn: vi.fn() };
const inputs: InputService[] = [];
let keys = 0;

interface SetupOptions {
  scores?: Partial<Record<Hazard, number>>;
  climate?: Pick<ClimateService, "getProfile">;
  llm?: ClassifierLlm;
  scorer?: Scorer;
  rateLimit?: number;
}

function setup(options: SetupOptions = {}) {
  const fake = fakeClimate(options.scores ?? { river_flood: 0.8, flash_flood: 0.5, heat: 0.6 });
  // The input service's finance triggers go to the finance service, as in server.ts
  const input = createInputService({
    prisma,
    llm: options.llm,
    now: () => NOW,
    logger: silent,
    ports: {
      finance: {
        firstProfile: ({ businessId }) => finance.getFinanceProfile(businessId, { trigger: "first_profile" }),
        recompute: ({ businessId }) => finance.getFinanceProfile(businessId, { trigger: "recompute" }),
      },
    },
  });
  inputs.push(input);
  const finance: FinanceService = createFinanceService({
    prisma,
    businesses: input,
    climate: options.climate ?? fake.climate,
    scorer: options.scorer,
    now: () => NOW,
    logger: silent,
  });
  const app = createApp({
    auth: { service: fakeAuth() },
    // The climate routes are not exercised here
    climate: {} as ClimateService,
    checkDb: connectDb,
    upstreamStatus: () => ({}) as UpstreamStatus,
    rateLimit: 10_000,
    input: { service: input, options: { rateLimit: 10_000 } },
    finance: {
      service: finance,
      assertAccess: (id, actor) => input.assertAccess(id, actor),
      rateLimit: options.rateLimit ?? 10_000,
    },
  });

  // A write with a fresh Idempotency-Key
  const send = (
    method: "post" | "put" | "patch",
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) => {
    keys += 1;
    return signedIn(app)[method](path).set("Idempotency-Key", `finance-${String(keys)}`).set(headers).send(body);
  };
  const create = async (business: Record<string, unknown> = {}) => {
    const res = await send("post", "/businesses", businessBody(business));
    expect(res.status).toBe(201);
    return (res.body as BusinessDetail).id;
  };
  const snapshot = async (id: string, financials: Record<string, unknown> = {}) => {
    const res = await send("post", `/businesses/${id}/snapshots`, financialsBody(financials));
    expect(res.status).toBe(201);
  };
  // A classified business with a financial snapshot, entered through the form API
  const onboard = async (business: Record<string, unknown> = {}, financials: Record<string, unknown> = {}) => {
    const id = await create(business);
    await input.idle();
    await snapshot(id, financials);
    return id;
  };
  const profile = async (id: string) => {
    const res = await signedIn(app).get(`/finance/business/${id}/profile`);
    return { res, body: res.body as FinanceProfile };
  };
  return { app, input, finance, fake, send, create, snapshot, onboard, profile };
}

const errorOf = (res: request.Response) =>
  (res.body as { error: { code: string; details?: { fields?: Record<string, string> } } }).error;
const stressOf = (body: { stress: FinanceProfile["stress"] }) => body.stress as Record<Hazard, HazardStress>;

beforeEach(async () => {
  silent.error.mockClear();
  silent.warn.mockClear();
  await prisma.$executeRaw`
    TRUNCATE TABLE users, businesses, input_request_log, finance_request_log RESTART IDENTITY CASCADE`;
  await prisma.user.createMany({ data: [OWNER, OTHER_OWNER].map(userRow) });
});

afterEach(async () => {
  await Promise.all(inputs.splice(0).map((input) => input.idle()));
});

afterAll(async () => {
  await disconnectDb();
});

describe("GET /finance/business/:id/profile", () => {
  it("returns a validated profile with baseline, stress, adjusted score and drivers", async () => {
    const { onboard, profile, fake } = setup();
    const id = await onboard();

    const { res, body } = await profile(id);

    expect(res.status).toBe(200);
    expect(() => financeProfileSchema.parse(body)).not.toThrow();
    expect(body).toMatchObject({
      business_id: id,
      generated_at: "2026-10-09T11:30:00+05:30",
      model_version: FINANCE.modelVersion,
      inputs: {
        snapshot_version: 1,
        snapshot_as_of: "2026-09-30",
        snapshot_verified: false,
        proposed_loan_ids: [],
        impact_profile_version: 1,
      },
      // Revenue 100,000, costs 60,000, EMI 10,000
      metrics: { avg_monthly_revenue: 100_000, net_monthly_cashflow: 40_000, dscr: 4, years_in_operation: 11 },
      // 0.3*100 + 0.2*85 + 0.15*85 + 0.1*80 + 0.15*75 + 0.1*100
      baseline: { score: 89, band: "low_risk", source: "rules" },
      climate: {
        profile_ref: "0.1:19.1:72.9@2026-10-09T11:30:00+05:30",
        cell_id: "0.1:19.1:72.9",
        fetched_at: "2026-10-09T11:30:00+05:30",
        grade: "C",
      },
      // No model is connected, so the classifier stored the sector defaults
      sensitivity: { source: "fallback" },
    });
    // The climate unit was asked about the business's primary location
    expect(fake.calls).toEqual([{ lat: 19.076, lon: 72.8777 }]);
    expect(Object.keys(body.stress).sort()).toEqual([...HAZARDS].sort());
    expect(body.adjusted?.score).toBeLessThan(body.baseline.score);
    expect(body.adjusted?.drivers[0]?.hazard).toBe("river_flood");
    expect(body.adjusted?.drivers[0]?.reason).toContain("River flood stress (severity 0.8");
    expect(body.summary).toContain(`Baseline 89 (low_risk); climate-adjusted ${String(body.adjusted?.score)}`);
    expect(body.warnings).toEqual([
      expect.stringContaining("snapshot_unverified"),
      expect.stringContaining("short_revenue_history: 6 months"),
    ]);
  });

  it("applies the business's insurance to the hazards it covers", async () => {
    const { onboard, profile } = setup();
    // The fixture business holds flood and stock cover

    const stress = stressOf((await profile(await onboard())).body);

    // Sector default 0.6 at severity 0.8 is a 48% loss; cover halves it
    expect(stress.river_flood).toMatchObject({
      gross_shock_pct: -48,
      shock_pct: -24,
      insurance_applied: ["flood", "stock"],
    });
    expect(stress.heat.insurance_applied).toEqual([]);
  });

  it("uses the classifier's profile and caps a favourable hazard", async () => {
    const { onboard, profile } = setup({ llm: fakeLlm().llm, scores: { heat: 1 } });

    const { body } = await profile(await onboard());

    expect(body.sensitivity.source).toBe("llm");
    // An ice cream shop in the heat: demand up 0.7, a fifth of trading lost
    expect(body.sensitivity.hazards.heat).toMatchObject({ direction: "favourable", magnitude: 0.36 });
    expect(stressOf(body).heat).toMatchObject({ gross_shock_pct: 36, shock_pct: 10 });
    expect(body.adjusted?.drivers.find((driver) => driver.hazard === "heat")?.points_change).toBeGreaterThan(0);
    expect(body.adjusted?.score).toBeLessThanOrEqual(body.baseline.score + FINANCE.adjusted.maxUplift);
  });

  it("uses a bank officer's override of the impact profile", async () => {
    const { onboard, profile, send } = setup();
    const id = await onboard();
    const override = await send(
      "put",
      `/businesses/${id}/impact-profile`,
      { reason: "Shop is on a raised plinth", conditions: { river_flood: { physical: 0, demand: 0 } } },
      BANK,
    );
    expect(override.status).toBe(200);

    const { body } = await profile(id);

    expect(body.sensitivity.source).toBe("override");
    expect(body.sensitivity.hazards.river_flood).toMatchObject({ direction: "neutral", magnitude: 0 });
    expect(stressOf(body).river_flood.shock_pct).toBe(0);
    expect(body.inputs.impact_profile_version).toBe(2);
  });

  it("falls back to sector defaults while the classifier is still running", async () => {
    const model = fakeLlm();
    const { create, snapshot, profile, input } = setup({ llm: model.llm });
    const release = model.hold();
    const id = await create();
    await snapshot(id);

    const { res, body } = await profile(id);
    release();
    await input.idle();

    expect(res.status).toBe(200);
    expect(body.sensitivity.source).toBe("fallback");
    expect(body.warnings).toContainEqual(expect.stringContaining("impact_profile_pending"));
  });

  it("counts a requested loan in the EMI, the DSCR and the leverage", async () => {
    const { onboard, profile, send } = setup();
    const id = await onboard();
    const loan = await send("post", `/businesses/${id}/loans`, loanBody(), BANK);
    expect(loan.status).toBe(201);

    const { body } = await profile(id);

    expect(body.inputs.proposed_loan_ids).toEqual([(loan.body as { loan: LoanView }).loan.id]);
    expect(body.metrics).toMatchObject({
      existing_emi: 10_000,
      proposed_emi: 10_000,
      total_emi: 20_000,
      dscr: 2,
      // (240,000 owed + 500,000 asked for) over a year's revenue
      leverage: 0.6167,
    });
  });

  it("still returns the baseline when the climate unit fails", async () => {
    const { onboard, profile, fake } = setup();
    const id = await onboard();
    fake.state.failing = true;

    const { res, body } = await profile(id);

    expect(res.status).toBe(200);
    expect(() => financeProfileSchema.parse(body)).not.toThrow();
    expect(body).toMatchObject({
      baseline: { score: 89, band: "low_risk" },
      climate: null,
      stress: {},
      adjusted: null,
    });
    expect(body.summary).toContain("Climate data is unavailable");
    expect(body.warnings).toContainEqual(expect.stringContaining("climate_unavailable: climate unit down"));
    expect(await prisma.financeProfile.findFirst()).toMatchObject({ baselineScore: 89, adjustedScore: null });
  });

  it("runs against the real climate pipeline", async () => {
    await prisma.$executeRaw`
      TRUNCATE TABLE request_log, cell_events, hazard_scores, climate_metrics, climate_responses,
        cell_hazard_relevance, point_static_features, points, grid_cells RESTART IDENTITY CASCADE`;
    const climate = createClimateService({
      prisma,
      openMeteo: fakeOpenMeteo(() => NOW),
      cache: memoryCache(),
      now: () => NOW,
      logger: silent,
    });
    const { onboard, profile } = setup({ climate });

    const { res, body } = await profile(await onboard());

    expect(res.status).toBe(200);
    expect(() => financeProfileSchema.parse(body)).not.toThrow();
    expect(body.climate?.cell_id).toBe("0.1:19.1:72.9");
    expect(Object.keys(body.stress)).toHaveLength(HAZARDS.length);
    expect(body.adjusted).not.toBeNull();
  });

  it("falls back to the rules and says so when the ML scorer fails", async () => {
    const scorer = createMlScorer({
      url: "http://ml.test/score",
      fetch: () => Promise.reject(new Error("connection refused")),
    });
    const { onboard, profile } = setup({ scorer });

    const { body } = await profile(await onboard());

    expect(body.baseline).toMatchObject({ score: 89, source: "rules" });
    expect(body.warnings).toContainEqual("ml_scorer_failed: connection refused");
    expect((await prisma.financeRequestLog.findFirst())?.fallbacks).toContain("scorer_rules");
  });

  it("answers 409 for a business with no financials yet", async () => {
    const { create, profile } = setup();

    const { res } = await profile(await create());

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("NO_FINANCIALS");
    expect(await prisma.financeRequestLog.findFirst()).toMatchObject({ ok: false, errorCode: "NO_FINANCIALS" });
  });

  it("is closed to strangers and to anyone not signed in", async () => {
    const { app, onboard } = setup();
    const id = await onboard();
    const path = `/finance/business/${id}/profile`;

    const anonymous = await request(app).get(path);
    const stranger = await signedIn(app, OTHER_OWNER).get(path);
    const officer = await signedIn(app, BANK_USER).get(path);
    const missing = await signedIn(app).get("/finance/business/no-such-business/profile");

    expect(anonymous.status).toBe(401);
    // Someone else's business looks the same as one that does not exist
    expect(stranger.status).toBe(404);
    expect(errorOf(stranger).code).toBe("BUSINESS_NOT_FOUND");
    expect(officer.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it("is rate limited", async () => {
    const { app, onboard } = setup({ rateLimit: 2 });
    const path = `/finance/business/${await onboard()}/profile`;

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await signedIn(app).get(path)).status);

    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("profile history and logging", () => {
  it("stores every generated profile with the inputs behind it", async () => {
    const { app, onboard, profile } = setup();
    const id = await onboard();
    const { body } = await profile(id);
    await profile(id);

    const rows = await prisma.financeProfile.findMany({ orderBy: { id: "asc" } });
    const history = await signedIn(app).get(`/finance/business/${id}/profiles`);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      businessId: id,
      snapshotVersion: 1,
      trigger: "request",
      baselineScore: 89,
      adjustedScore: body.adjusted?.score,
      scorerSource: "rules",
      modelVersion: FINANCE.modelVersion,
      inputs: {
        monthly_revenue: [80_000, 90_000, 100_000, 110_000, 120_000, 100_000],
        monthly_expenses: 60_000,
        existing_emi: 10_000,
        cash_reserves: 90_000,
      },
      profile: body,
    });
    expect(history.status).toBe(200);
    expect((history.body as { profiles: { id: number; trigger: string }[] }).profiles).toMatchObject([
      { id: 2, trigger: "request", baseline_score: 89 },
      { id: 1, trigger: "request", baseline_score: 89 },
    ]);
  });

  it("logs each request with its stages, sources and fallbacks", async () => {
    const { onboard, profile } = setup();
    const id = await onboard();

    await profile(id);

    const row = await prisma.financeRequestLog.findFirst();
    expect(row).toMatchObject({
      operation: "profile",
      businessId: id,
      ok: true,
      errorCode: null,
      sensitivitySource: "fallback",
      scorerSource: "rules",
      fallbacks: ["sensitivity_sector_defaults"],
    });
    expect(row?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(row?.stageMs as object).sort()).toEqual([
      "adjusted",
      "baseline",
      "build",
      "climate",
      "load_business",
      "metrics",
      "store",
      "stress",
    ]);
  });

  it("stores a profile when a loan is authorised and when its financials change", async () => {
    const { onboard, send, snapshot } = setup();
    const id = await onboard();
    const loan = await send("post", `/businesses/${id}/loans`, loanBody(), BANK);
    const loanId = (loan.body as { loan: LoanView }).loan.id;

    const authorised = await send("patch", `/loans/${loanId}/status`, { status: "authorised" }, BANK);
    await snapshot(id, { cash_balance: 150_000 });

    expect(authorised.status).toBe(200);
    const rows = await prisma.financeProfile.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((row) => [row.trigger, row.snapshotVersion])).toEqual([
      ["first_profile", 1],
      ["recompute", 2],
    ]);
    expect(await prisma.inputTriggerJob.count({ where: { kind: { startsWith: "finance" }, status: "done" } })).toBe(2);
  });
});

// Ten synthetic SMEs entered through the form API, as the seed file's
// entries would be (smes.json is not in the repository)
const SMES = [
  { sector: "retail", revenue: 180_000, opex: 120_000, emi: 15_000, debt: 300_000, cash: 150_000, delays: 0, started: 2012 },
  { sector: "agriculture", revenue: 90_000, opex: 70_000, emi: 12_000, debt: 400_000, cash: 30_000, delays: 3, started: 2019 },
  { sector: "construction", revenue: 600_000, opex: 520_000, emi: 60_000, debt: 2_500_000, cash: 200_000, delays: 2, started: 2016 },
  { sector: "food_beverage", revenue: 250_000, opex: 190_000, emi: 0, debt: 0, cash: 80_000, delays: 0, started: 2021 },
  { sector: "manufacturing", revenue: 900_000, opex: 700_000, emi: 90_000, debt: 3_000_000, cash: 600_000, delays: 1, started: 2005 },
  { sector: "hospitality_tourism", revenue: 320_000, opex: 300_000, emi: 40_000, debt: 1_200_000, cash: 60_000, delays: 5, started: 2023 },
  { sector: "logistics", revenue: 450_000, opex: 380_000, emi: 35_000, debt: 900_000, cash: 120_000, delays: 1, started: 2014 },
  { sector: "healthcare_pharmacy", revenue: 210_000, opex: 150_000, emi: 10_000, debt: 150_000, cash: 220_000, delays: 0, started: 2009 },
  { sector: "delivery_ecommerce", revenue: 140_000, opex: 150_000, emi: 8_000, debt: 200_000, cash: 40_000, delays: 4, started: 2025 },
  { sector: "other", revenue: 75_000, opex: 50_000, emi: 5_000, debt: 60_000, cash: 20_000, delays: 0, started: 2018 },
] as const;

describe("ten SMEs through the form API", () => {
  it("gives each a valid profile whose adjusted score respects the cap", async () => {
    const { onboard, profile } = setup({
      scores: { river_flood: 0.7, flash_flood: 0.6, heat: 0.8, drought: 0.5, storm: 0.4, cold_wave: 0.2 },
    });
    const bands = new Set<string>();

    for (const [index, sme] of SMES.entries()) {
      const seasonal = [0.8, 0.9, 1, 1.1, 1.2, 1, 0.8, 0.9, 1, 1.1, 1.2, 1];
      const id = await onboard(
        {
          profile: {
            ...(businessBody().profile as object),
            name: `SME ${String(index + 1)}`,
            sector: sme.sector,
            year_started: sme.started,
          },
        },
        {
          monthly_revenue: seasonal.map((factor) => Math.round(sme.revenue * factor)),
          monthly_opex: sme.opex,
          existing_emi_total: sme.emi,
          outstanding_debt: sme.debt,
          cash_balance: sme.cash,
          payment_delays_12m: sme.delays,
        },
      );

      const { res, body } = await profile(id);

      expect(res.status).toBe(200);
      expect(() => financeProfileSchema.parse(body)).not.toThrow();
      expect(body.metrics.months_of_history).toBe(12);
      expect(Object.keys(body.stress)).toHaveLength(HAZARDS.length);
      expect(body.adjusted).not.toBeNull();
      expect(body.adjusted?.score).toBeLessThanOrEqual(body.baseline.score + FINANCE.adjusted.maxUplift);
      expect(body.adjusted?.score).toBeGreaterThanOrEqual(0);
      bands.add(body.baseline.band);
    }

    // The set is not all alike: it spans healthy and distressed businesses
    expect(bands.size).toBeGreaterThanOrEqual(3);
    expect(await prisma.financeProfile.count()).toBe(SMES.length);
  });
});

describe("POST /finance/business/:id/scenario", () => {
  it("runs the stress test for a hypothetical event", async () => {
    const { onboard, send, fake } = setup();
    const id = await onboard();

    const res = await send("post", `/finance/business/${id}/scenario`, {
      hazard: "storm",
      severity: 1,
      duration_months: 3,
    });
    const body = res.body as ScenarioResult;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      business_id: id,
      scenario: { hazard: "storm", severity: 1, duration_months: 3 },
      baseline: { score: 89 },
      // Sector default 0.4, halved by the stock cover
      stress: { shock_pct: -20, insurance_applied: ["stock"], duration_months: 3, breach: false },
    });
    expect(body.adjusted.score).toBeLessThan(89);
    expect(body.summary).toContain("Storm stress (severity 1, revenue down 20% after stock insurance)");
    expect(body.summary).toContain("over 3 months");
    expect(body.summary).toContain("No threshold is breached.");
    // A hypothetical needs no climate lookup, and is not kept as a profile
    expect(fake.calls).toEqual([]);
    expect(await prisma.financeProfile.count()).toBe(0);
  });

  it("uses the default duration and reports a breach", async () => {
    const { onboard, send } = setup();
    const id = await onboard({}, { existing_emi_total: 35_000 });

    const res = await send("post", `/finance/business/${id}/scenario`, { hazard: "river_flood", severity: 1 });
    const body = res.body as ScenarioResult;

    expect(body.stress).toMatchObject({ shock_pct: -30, duration_months: 2, breach: true });
    expect(body.summary).toContain("Breaches: dscr_below_1");
  });

  it("rejects a scenario it cannot run", async () => {
    const { onboard, send } = setup();
    const id = await onboard();

    const res = await send("post", `/finance/business/${id}/scenario`, { hazard: "tsunami", severity: 2 });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("VALIDATION_FAILED");
    expect(Object.keys(errorOf(res).details?.fields ?? {}).sort()).toEqual(["hazard", "severity"]);
  });
});

describe("POST /finance/business/:id/repayment-capacity", () => {
  it("returns the largest affordable EMI and the monthly shortfall", async () => {
    const { onboard, send } = setup();
    const id = await onboard();

    const res = await send("post", `/finance/business/${id}/repayment-capacity`, {
      revenue_drop_pct: 50,
      months: 3,
    });

    expect(res.status).toBe(200);
    // Revenue 50,000 against costs of 60,000 and an EMI of 10,000
    expect(res.body as RepaymentCapacity).toMatchObject({
      business_id: id,
      stressed: { monthly_revenue: 50_000, net_monthly_cashflow: -10_000, dscr: -1 },
      current_total_emi: 10_000,
      target_dscr: 1.25,
      max_affordable_emi: 0,
      shortfall_per_month: 20_000,
      total_shortfall: 60_000,
      cash_reserves: 90_000,
      reserves_cover_months: 4.5,
      uncovered_after_reserves: 0,
      summary:
        "With revenue down 50% for 3 months, it falls ₹20,000 short each month (₹60,000 in all); " +
        "reserves cover 4.5 months, leaving ₹0 uncovered. The largest EMI it can carry at a DSCR of 1.25 is ₹0.",
    });
  });

  it("reports no shortfall while the EMIs are still met", async () => {
    const { onboard, send } = setup();
    const id = await onboard();

    const res = await send("post", `/finance/business/${id}/repayment-capacity`, {
      revenue_drop_pct: 10,
      months: 6,
    });

    // Revenue 90,000 leaves 30,000 after costs: 24,000 of EMI at a DSCR of 1.25
    expect(res.body as RepaymentCapacity).toMatchObject({
      max_affordable_emi: 24_000,
      shortfall_per_month: 0,
      reserves_cover_months: null,
    });
    expect((res.body as RepaymentCapacity).summary).toContain("still meets its EMIs of ₹10,000");
  });

  it("validates its arguments", async () => {
    const { onboard, send } = setup();

    const res = await send("post", `/finance/business/${await onboard()}/repayment-capacity`, {
      revenue_drop_pct: 150,
    });

    expect(res.status).toBe(422);
    expect(Object.keys(errorOf(res).details?.fields ?? {}).sort()).toEqual(["months", "revenue_drop_pct"]);
  });
});

describe("POST /finance/evaluate-location", () => {
  it("scores an unsaved business at a candidate location", async () => {
    const { send, fake } = setup();

    const res = await send("post", "/finance/evaluate-location", {
      business: DEMO.business,
      lat: 26.1445,
      lon: 91.7362,
    });
    const body = res.body as LocationEvaluation;

    expect(res.status).toBe(200);
    expect(fake.calls).toEqual([{ lat: 26.1445, lon: 91.7362 }]);
    expect(body.location).toEqual({ lat: 26.1445, lon: 91.7362 });
    // The requested loan's EMI comes from the amortisation formula
    const emi = amortisedEmi(800_000, 13, 48);
    expect(body.loan_request).toEqual({ amount: 800_000, tenure_months: 48, interest_rate: 13, emi });
    expect(body.metrics).toMatchObject({ existing_emi: 28_000, proposed_emi: emi });
    expect(body.sensitivity.source).toBe("fallback");
    expect(body.adjusted?.score).toBeLessThanOrEqual(body.baseline.score + FINANCE.adjusted.maxUplift);
    expect(body.summary).toContain(`Baseline ${String(body.baseline.score)}`);
    // Nothing about an unsaved business is stored
    expect(await prisma.business.count()).toBe(0);
    expect(await prisma.financeProfile.count()).toBe(0);
  });

  it("rejects a location outside India and a bad draft", async () => {
    const { send } = setup();

    const abroad = await send("post", "/finance/evaluate-location", {
      business: DEMO.business,
      lat: 51.5,
      lon: -0.12,
    });
    const bad = await send("post", "/finance/evaluate-location", {
      business: { ...DEMO.business, sector: "banking", financials: { ...DEMO.business.financials, monthly_revenue: [0, 0, 0, 0, 0, 0] } },
      lat: 26.1445,
      lon: 91.7362,
    });

    expect(abroad.status).toBe(422);
    expect(errorOf(abroad).code).toBe("OUTSIDE_COVERAGE");
    expect(bad.status).toBe(422);
    expect(Object.keys(errorOf(bad).details?.fields ?? {}).sort()).toEqual([
      "financials.monthly_revenue",
      "sector",
    ]);
  });
});

describe("GET /finance/demo", () => {
  it("runs the sample business end to end", async () => {
    const { app, fake } = setup();

    const res = await signedIn(app).get("/finance/demo");
    const body = res.body as { sample: typeof DEMO; result: LocationEvaluation };

    expect(res.status).toBe(200);
    expect(body.sample.label).toBe(DEMO.label);
    expect(fake.calls).toEqual([{ lat: DEMO.lat, lon: DEMO.lon }]);
    expect(body.result.baseline.score).toBeGreaterThan(0);
    expect(body.result.adjusted).not.toBeNull();
    expect(Object.keys(body.result.stress)).toHaveLength(HAZARDS.length);
  });

  it("needs a signed-in user", async () => {
    const { app } = setup();

    expect((await request(app).get("/finance/demo")).status).toBe(401);
  });
});
