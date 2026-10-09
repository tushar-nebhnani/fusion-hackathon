import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { connectDb, disconnectDb, prisma } from "../../config/db.js";
import type { UpstreamStatus } from "../climate/open-meteo.js";
import type { ClimateService } from "../climate/profile.service.js";
import type { ClassifierLlm } from "./classifier/index.js";
import { loadSeedFile, seedSmes, type SeedReport } from "./seed.js";
import { createInputService, type InputService } from "./service.js";
import { businessBody, fakeLlm, financialsBody, loanBody } from "./testing/fixtures.js";

const NOW = new Date("2026-10-09T06:00:00Z");
const silent = { error: vi.fn(), warn: vi.fn() };
const services: InputService[] = [];
let dir = "";

function makeService(llm?: ClassifierLlm): InputService {
  const service = createInputService({ prisma, llm, now: () => NOW, logger: silent });
  services.push(service);
  return service;
}

const entry = (id: string, extra: object = {}) => ({ external_id: id, business: businessBody(), ...extra });

async function seedFile(content: unknown): Promise<string> {
  const path = join(dir, `smes-${String(Date.now())}-${String(Math.random()).slice(2)}.json`);
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "input-seed-"));
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE businesses, input_request_log RESTART IDENTITY CASCADE`;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.idle()));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await disconnectDb();
});

describe("seedSmes", () => {
  it("loads entries through the same path as the form, marked synthetic", async () => {
    const service = makeService();

    const report = await seedSmes(service, [
      entry("sme-001", { snapshot: financialsBody(), loan: { ...loanBody(), status: "active" } }),
      entry("sme-002"),
    ]);

    expect(report).toEqual({ total: 2, created: 2, skipped: 0, failed: [] });
    const id = await service.findBusinessIdByExternalId("sme-001");
    const business = await service.getBusiness(id ?? "");
    expect(business).toMatchObject({
      source: "synthetic",
      external_id: "sme-001",
      loans: [{ status: "active" }],
      latest_snapshot: { version: 1, derived: { avg_revenue: 100_000, dscr: 4 } },
    });
    expect(await service.activeLocations()).toHaveLength(1);
  });

  it("counts a loan that is only applied for in the snapshot's debt service", async () => {
    const service = makeService();

    await seedSmes(service, [entry("sme-001", { snapshot: financialsBody(), loan: loanBody() })]);

    const id = await service.findBusinessIdByExternalId("sme-001");
    const business = await service.getBusiness(id ?? "");
    expect(business.loans).toMatchObject([{ status: "applied" }]);
    expect(business.latest_snapshot?.derived).toMatchObject({ debt_service_month: 20_000, dscr: 2 });
  });

  it("gives seeded businesses their sector defaults without calling the model", async () => {
    const { llm, requests } = fakeLlm();
    const service = makeService(llm);

    await seedSmes(service, [entry("sme-001"), entry("sme-002")]);
    await service.idle();

    expect(requests).toHaveLength(0);
    const id = await service.findBusinessIdByExternalId("sme-001");
    expect(await service.getImpactProfile(id ?? "")).toMatchObject({
      status: "fallback",
      category: "food_beverage",
      note: "stored with sector defaults; the classifier was not run",
    });
  });

  it("classifies with the model when asked to", async () => {
    const { llm, requests } = fakeLlm();
    const service = makeService(llm);

    await seedSmes(service, [entry("sme-001")], { classify: "llm" });
    await service.idle();

    expect(requests).toHaveLength(1);
    const id = await service.findBusinessIdByExternalId("sme-001");
    expect(await service.getImpactProfile(id ?? "")).toMatchObject({ status: "ok" });
  });

  it("skips entries that were already loaded", async () => {
    const service = makeService();
    await seedSmes(service, [entry("sme-001")]);

    const report = await seedSmes(service, [entry("sme-001"), entry("sme-002")]);

    expect(report).toMatchObject({ total: 2, created: 1, skipped: 1, failed: [] });
    expect(await prisma.business.count()).toBe(2);
  });

  it("reports a bad entry, stores none of it and still loads the rest", async () => {
    const service = makeService();
    const noConsent = { data_processing: false, share_with_bank: true, alerts: true };

    const report = await seedSmes(service, [
      entry("bad-business", { business: businessBody({ suppliers: [] }) }),
      entry("no-consent", { business: businessBody({ consent: noConsent }) }),
      // The business is valid; its snapshot is not
      entry("bad-snapshot", { snapshot: financialsBody({ monthly_revenue: [0, 0, 0, 0, 0, 0] }) }),
      { business: businessBody() },
      entry("good"),
    ]);

    expect(report).toMatchObject({ total: 5, created: 1, skipped: 0 });
    expect(report.failed).toMatchObject([
      { index: 0, external_id: "bad-business", code: "VALIDATION_FAILED", details: { fields: { suppliers: expect.any(String) as string } } },
      { index: 1, external_id: "no-consent", code: "CONSENT_REQUIRED" },
      { index: 2, external_id: "bad-snapshot", code: "INVALID_FINANCIALS" },
      { index: 3, external_id: null, code: "VALIDATION_FAILED" },
    ]);
    const stored = await prisma.business.findMany({ select: { externalId: true } });
    expect(stored).toEqual([{ externalId: "good" }]);
  });
});

describe("loadSeedFile", () => {
  it("reads a JSON array of entries", async () => {
    const path = await seedFile([entry("sme-001")]);

    expect(await loadSeedFile(path)).toHaveLength(1);
  });

  it("refuses a missing file and a file that is not an array", async () => {
    await expect(loadSeedFile(join(dir, "missing.json"))).rejects.toMatchObject({
      statusCode: 404,
      code: "SEED_FILE_NOT_FOUND",
    });
    await expect(loadSeedFile(await seedFile({ not: "an array" }))).rejects.toMatchObject({
      statusCode: 422,
      code: "INVALID_SEED_FILE",
    });
    await expect(loadSeedFile(await seedFile("{ broken"))).rejects.toMatchObject({
      code: "INVALID_SEED_FILE",
    });
  });
});

describe("POST /seed/smes", () => {
  function appWith(seed?: { enabled: boolean; file: string }) {
    const service = makeService();
    const app = createApp({
      climate: {} as ClimateService,
      checkDb: connectDb,
      upstreamStatus: () => ({}) as UpstreamStatus,
      rateLimit: 10_000,
      input: { service, options: { rateLimit: 10_000, seed } },
    });
    const post = (key: string, body?: object) =>
      request(app).post("/seed/smes").set("Idempotency-Key", key).send(body);
    return { app, post };
  }

  it("loads the seed file", async () => {
    const file = await seedFile([entry("sme-001"), entry("sme-002")]);
    const { post } = appWith({ enabled: true, file });

    const res = await post("seed-1");

    expect(res.status).toBe(200);
    expect(res.body as SeedReport).toEqual({ total: 2, created: 2, skipped: 0, failed: [] });
    expect(await prisma.business.count({ where: { source: "synthetic" } })).toBe(2);
  });

  it("does not exist unless seeding is enabled", async () => {
    const file = await seedFile([entry("sme-001")]);

    for (const seed of [undefined, { enabled: false, file }]) {
      const res = await appWith(seed).post("seed-off");
      expect(res.status).toBe(404);
    }
    expect(await prisma.business.count()).toBe(0);
  });

  it("answers 404 when the seed file is missing and 422 for an unknown option", async () => {
    const missing = await appWith({ enabled: true, file: join(dir, "nope.json") }).post("seed-2");
    const file = await seedFile([]);
    const option = await appWith({ enabled: true, file }).post("seed-3", { classify: "everything" });

    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe("SEED_FILE_NOT_FOUND");
    expect(option.status).toBe(422);
  });

  it("requires an Idempotency-Key", async () => {
    const file = await seedFile([entry("sme-001")]);
    const { app } = appWith({ enabled: true, file });

    const res = await request(app).post("/seed/smes");

    expect(res.status).toBe(400);
    expect(await prisma.business.count()).toBe(0);
  });
});
