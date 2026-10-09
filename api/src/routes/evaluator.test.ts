import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { connectDb, disconnectDb, prisma } from "../config/db.js";
import { OTHER_OWNER, OWNER, fakeAuth, signedIn, userRow } from "../services/auth/testing/fake-auth.js";
import type { UpstreamStatus } from "../services/climate/open-meteo.js";
import type { ClimateService } from "../services/climate/profile.service.js";
import { runChecks } from "../services/evaluator/checks.js";
import {
  createEvaluatorService,
  createPrismaEvaluationStore,
  evaluationSchema,
  type Evaluation,
} from "../services/evaluator/index.js";
import { FINANCE } from "../services/finance/config.js";
import { createFinanceService } from "../services/finance/index.js";
import { climateProfile, fakeClimate } from "../services/finance/testing/fixtures.js";
import { createInputService, type InputService } from "../services/input/service.js";
import { businessBody, financialsBody } from "../services/input/testing/fixtures.js";

// Integration tests: the real app, input, finance and evaluator on Postgres,
// with a stand-in climate unit
const NOW = new Date("2026-10-09T06:00:00Z");
const silent = { error: vi.fn(), warn: vi.fn() };
const inputs: InputService[] = [];

function setup() {
  const fake = fakeClimate({ river_flood: 0.8, flash_flood: 0.5, heat: 0.6 });
  const input = createInputService({ prisma, now: () => NOW, logger: silent });
  inputs.push(input);
  const finance = createFinanceService({ prisma, businesses: input, climate: fake.climate, now: () => NOW, logger: silent });
  const evaluator = createEvaluatorService({
    climate: fake.climate,
    businesses: input,
    finance,
    store: createPrismaEvaluationStore(prisma),
    now: () => NOW,
    logger: silent,
  });
  const app = createApp({
    auth: { service: fakeAuth() },
    climate: {} as ClimateService,
    checkDb: connectDb,
    upstreamStatus: () => ({}) as UpstreamStatus,
    rateLimit: 10_000,
    evaluator: { service: evaluator, assertAccess: (id, actor) => input.assertAccess(id, actor), rateLimit: 10_000 },
  });
  // A business of OWNER, with one snapshot unless told otherwise
  const business = async (snapshot = true) => {
    const { id } = await input.createBusiness(businessBody(), { ownerUserId: OWNER.id, classifier: "defaults" });
    if (snapshot) await input.createSnapshot(id, financialsBody());
    await input.idle();
    return id;
  };
  const evaluate = async (id: string) => {
    const res = await signedIn(app).get(`/evaluate/business/${id}`);
    return { res, body: res.body as Evaluation };
  };
  return { app, fake, input, finance, evaluator, business, evaluate };
}

const check = (evaluation: Evaluation, id: string) => evaluation.checks.find((c) => c.id === id);

beforeEach(async () => {
  silent.error.mockClear();
  silent.warn.mockClear();
  await prisma.$executeRaw`TRUNCATE TABLE users, businesses, evaluations RESTART IDENTITY CASCADE`;
  await prisma.user.createMany({ data: [OWNER, OTHER_OWNER].map(userRow) });
});

afterEach(async () => {
  await Promise.all(inputs.splice(0).map((input) => input.idle()));
});

afterAll(async () => {
  await disconnectDb();
});

describe("GET /evaluate/business/:id", () => {
  it("evaluates both answers, rates them together and stores the result", async () => {
    const { business, evaluate } = setup();
    const id = await business();

    const { res, body } = await evaluate(id);

    expect(res.status).toBe(200);
    expect(() => evaluationSchema.parse(body)).not.toThrow();
    expect(body).toMatchObject({
      business_id: id,
      reliable: true,
      climate: { grade: "C" },
      finance: { origin: "computed", snapshot_version: 1, profile_id: 1 },
    });
    expect(body.rating).not.toBe("insufficient_data");
    expect(body.evaluation_id).toBe(1);
    expect(check(body, "same_location")?.status).toBe("pass");
    expect(check(body, "same_climate_run")?.status).toBe("pass");
    expect(check(body, "snapshot_verified")?.status).toBe("warn");
    expect(body.reasons.some((reason) => reason.startsWith("Finance: climate-adjusted score"))).toBe(true);

    const row = await prisma.evaluation.findUniqueOrThrow({ where: { id: 1 } });
    expect(row).toMatchObject({ businessId: id, requesterId: OWNER.id, rating: body.rating, reliable: true, financeProfileId: 1 });
  });

  it("reuses the stored finance profile until a new snapshot arrives", async () => {
    const { business, evaluate, input } = setup();
    const id = await business();

    await evaluate(id);
    const again = await evaluate(id);
    expect(again.body.finance?.origin).toBe("reused");
    expect(await prisma.financeProfile.count()).toBe(1);

    await input.createSnapshot(id, financialsBody({ as_of: "2026-10-08" }));
    const after = await evaluate(id);
    expect(after.body.finance).toMatchObject({ origin: "computed", snapshot_version: 2 });
    expect(check(after.body, "finance_current")?.status).toBe("pass");
  });

  it("lists stored evaluations, newest first", async () => {
    const { app, business, evaluate } = setup();
    const id = await business();
    await evaluate(id);
    await evaluate(id);

    const res = await signedIn(app).get(`/evaluate/business/${id}/history`);

    expect(res.status).toBe(200);
    expect((res.body as { evaluations: { evaluation_id: number }[] }).evaluations.map((e) => e.evaluation_id)).toEqual([2, 1]);
  });

  it("is not reliable, and gives no rating, when the climate unit is down", async () => {
    const { business, evaluate, fake } = setup();
    const id = await business();
    fake.state.failing = true;

    const { res, body } = await evaluate(id);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ reliable: false, rating: "insufficient_data", climate: null });
    expect(check(body, "climate_available")).toMatchObject({ status: "fail" });
    expect(body.reasons[0]).toContain("Not reliable: Climate profile unavailable");
  });

  it("is not reliable when there is no snapshot to score", async () => {
    const { business, evaluate } = setup();
    const id = await business(false);

    const { body } = await evaluate(id);

    expect(body).toMatchObject({ reliable: false, rating: "insufficient_data", finance: null });
    expect(check(body, "finance_available")?.status).toBe("fail");
  });

  it("hides another owner's business and needs a session", async () => {
    const { app, business } = setup();
    const id = await business();

    expect((await signedIn(app, OTHER_OWNER).get(`/evaluate/business/${id}`)).status).toBe(404);
    expect((await request(app).get(`/evaluate/business/${id}`)).status).toBe(401);
    expect(await prisma.evaluation.count()).toBe(0);
  });
});

describe("checks on real profiles", () => {
  it("catches a finance profile from another cell, an old snapshot and a score above the cap", async () => {
    const { business, finance } = setup();
    const id = await business();
    const profile = await finance.getFinanceProfile(id);
    const climate = climateProfile();
    const other = { ...climate, location: { ...climate.location, cells: { ...climate.location.cells, forecast: "0.1:20:73" } } };
    const inflated = { ...profile, adjusted: { ...profile.adjusted!, score: profile.baseline.score + FINANCE.adjusted.maxUplift + 1 } };

    const checks = runChecks({
      climate: { status: "ok", profile: other },
      finance: { status: "ok", profile: inflated },
      latestSnapshotVersion: 2,
      now: NOW,
    });
    const status = (checkId: string) => checks.find((c) => c.id === checkId)?.status;

    expect(status("same_location")).toBe("fail");
    expect(status("finance_current")).toBe("fail");
    expect(status("adjustment_cap")).toBe("fail");
    expect(status("finance_schema")).toBe("pass");
  });
});
