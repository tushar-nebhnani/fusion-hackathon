import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import {
  BANK as BANK_USER,
  OTHER_OWNER,
  OWNER,
  cookieFor,
  fakeAuth,
  signedIn,
  userRow,
} from "../auth/testing/fake-auth.js";
import { connectDb, disconnectDb, prisma } from "../../config/db.js";
import { memoryAuditRecorder } from "../audit/testing/memory-recorder.js";
import type { UpstreamStatus } from "../climate/open-meteo.js";
import type { ClimateService } from "../climate/profile.service.js";
import type { ClassifierLlm } from "./classifier/index.js";
import { INPUT } from "./config.js";
import { createInputService, type BusinessDetail, type InputService } from "./service.js";
import type { ImpactProfileView, LoanView, SnapshotView } from "./store.js";
import { businessBody, fakeLlm, fakePorts, financialsBody, loanBody, validReply } from "./testing/fixtures.js";
import type { InputPorts } from "./triggers.js";

// Integration tests: the real Express app and Postgres. The model and the
// climate and finance services are stand-ins.
const NOW = new Date("2026-10-09T06:00:00Z");
// Requests are signed in as the owner unless they carry one of these
const BANK = { Cookie: cookieFor(BANK_USER) };
const STRANGER = { Cookie: cookieFor(OTHER_OWNER) };
const silent = { error: vi.fn(), warn: vi.fn() };
const services: InputService[] = [];
let keys = 0;

interface SetupOptions {
  llm?: ClassifierLlm;
  ports?: InputPorts;
  rateLimit?: number;
}

function setup(options: SetupOptions = {}) {
  const service = createInputService({
    prisma,
    llm: options.llm,
    ports: options.ports,
    now: () => NOW,
    logger: silent,
    triggerTimeoutMs: 100,
  });
  services.push(service);
  const audit = memoryAuditRecorder();
  const app = createApp({
    auth: { service: fakeAuth() },
    audit,
    // The climate routes are not exercised here
    climate: {} as ClimateService,
    checkDb: connectDb,
    upstreamStatus: () => ({}) as UpstreamStatus,
    rateLimit: 10_000,
    input: { service, options: { rateLimit: options.rateLimit ?? 10_000 } },
  });

  // A write with a fresh Idempotency-Key
  const send = (
    method: "post" | "put" | "patch",
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) => {
    keys += 1;
    return signedIn(app)[method](path).set("Idempotency-Key", `key-${String(keys)}`).set(headers).send(body);
  };
  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await send("post", "/businesses", businessBody(overrides));
    expect(res.status).toBe(201);
    return res.body as BusinessDetail;
  };
  const profile = async (id: string) => {
    await service.idle();
    const res = await signedIn(app).get(`/businesses/${id}/impact-profile`);
    return res.body as ImpactProfileView;
  };
  return { app, service, send, create, profile, audit };
}

const errorOf = (res: request.Response) =>
  (res.body as { error: { code: string; details?: { fields?: Record<string, string> } } }).error;
const fieldsOf = (res: request.Response) => errorOf(res).details?.fields ?? {};

beforeEach(async () => {
  silent.error.mockClear();
  silent.warn.mockClear();
  await prisma.$executeRaw`TRUNCATE TABLE users, businesses, input_request_log RESTART IDENTITY CASCADE`;
  await prisma.user.createMany({ data: [OWNER, OTHER_OWNER].map(userRow) });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.idle()));
});

afterAll(async () => {
  await disconnectDb();
});

describe("POST /businesses", () => {
  it("validates, stores and returns the business", async () => {
    const { create } = setup();

    const business = await create();

    expect(business.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(business).toMatchObject({
      source: "user",
      profile: { name: "Sharma Cold Drinks", sector: "food_beverage", year_started: 2015 },
      locations: {
        primary: { lat: 19.076, lon: 72.8777, pincode: "400014", floor: "ground" },
        additional_locations: [],
      },
      operations: { power_outage_hrs_month: 12, insurance_covers: ["flood", "stock"] },
      contacts: { owner: { phone: "+919876543210", language: "en" }, alerts: { channels: ["sms", "email"] } },
      latest_snapshot: null,
      loans: [],
    });
    expect(business.suppliers).toEqual([
      { name: "Amul Depot", lat: 19.2, lon: 72.97, share: 0.6, critical: true },
      { name: "Pune Packaging", lat: 18.52, lon: 73.8567, share: 0.4, critical: false },
    ]);
  });

  it("stamps the consent with the server's time and consent version", async () => {
    const { create } = setup();

    const business = await create();

    expect(business.consent).toEqual({
      data_processing: true,
      share_with_bank: true,
      alerts: true,
      timestamp: NOW.toISOString(),
      version: INPUT.consentVersion,
    });
  });

  it("answers 422 with an error per field", async () => {
    const { send } = setup();
    const body = businessBody();
    const profile = { ...(body.profile as object), name: "A", description: "short", gstin: "123" };
    const locations = { primary: { lat: "19.07", lon: 72.87, address: "x", pincode: "4000" } };

    const res = await send("post", "/businesses", { ...body, profile, locations });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("VALIDATION_FAILED");
    expect(Object.keys(fieldsOf(res)).sort()).toEqual([
      "locations.primary.lat",
      "locations.primary.pincode",
      "profile.description",
      "profile.gstin",
      "profile.name",
    ]);
    expect(await prisma.business.count()).toBe(0);
  });

  it("answers 403 CONSENT_REQUIRED without data-processing consent and stores nothing", async () => {
    const { send } = setup();
    const consent = { data_processing: false, share_with_bank: true, alerts: true };

    const res = await send("post", "/businesses", businessBody({ consent }));

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("CONSENT_REQUIRED");
    expect(await prisma.business.count()).toBe(0);
  });

  it("checks the schema before consent, and consent before the cross-field checks", async () => {
    const { send } = setup();
    const noConsent = { data_processing: false, share_with_bank: true, alerts: true };
    const badShares = [{ name: "Only", lat: 19, lon: 73, share: 0.5 }];

    const malformed = await send("post", "/businesses", businessBody({ consent: noConsent, suppliers: [] }));
    const unconsented = await send("post", "/businesses", businessBody({ consent: noConsent, suppliers: badShares }));

    expect(malformed.status).toBe(422);
    expect(unconsented.status).toBe(403);
  });

  it("refuses supplier shares that do not sum to 1.0", async () => {
    const { send } = setup();
    const suppliers = [
      { name: "A", lat: 19, lon: 73, share: 0.5 },
      { name: "B", lat: 19, lon: 73, share: 0.35 },
    ];

    const res = await send("post", "/businesses", businessBody({ suppliers }));

    expect(res.status).toBe(422);
    expect(fieldsOf(res)).toEqual({ suppliers: "shares sum to 0.85, must be 1.0" });
  });

  it("refuses locations and suppliers outside the climate unit's coverage", async () => {
    const { send } = setup();
    const body = businessBody();
    const primary = { ...(body.locations as { primary: object }).primary, lat: 51.5, lon: -0.12 };
    const suppliers = [{ name: "Far", lat: 1.35, lon: 103.8, share: 1 }];

    const res = await send("post", "/businesses", { ...body, locations: { primary }, suppliers });

    expect(res.status).toBe(422);
    expect(Object.keys(fieldsOf(res)).sort()).toEqual(["locations.primary", "suppliers.0"]);
  });

  it("reports cross-field problems from several groups together", async () => {
    const { send } = setup();
    const body = businessBody();
    const profile = { ...(body.profile as object), year_started: 2027 };
    const operations = { power_outage_hrs_month: 5, has_insurance: false, insurance_covers: ["flood"] };

    const res = await send("post", "/businesses", { ...body, profile, operations });

    expect(res.status).toBe(422);
    expect(Object.keys(fieldsOf(res)).sort()).toEqual(["operations.insurance_covers", "profile.year_started"]);
  });

  it("requires an Idempotency-Key on writes", async () => {
    const { app } = setup();

    const res = await signedIn(app).post("/businesses").send(businessBody());

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("MISSING_IDEMPOTENCY_KEY");
    expect(await prisma.business.count()).toBe(0);
  });

  it("replays a repeated Idempotency-Key instead of creating a second business", async () => {
    const { app } = setup();
    const post = () => signedIn(app).post("/businesses").set("Idempotency-Key", "same-key").send(businessBody());

    const first = await post();
    const second = await post();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect((second.body as BusinessDetail).id).toBe((first.body as BusinessDetail).id);
    expect(await prisma.business.count()).toBe(1);
  });

  it("is rate limited", async () => {
    const { app } = setup({ rateLimit: 2 });
    const get = () => signedIn(app).get("/businesses/none");

    expect((await get()).status).toBe(404);
    expect((await get()).status).toBe(404);
    const limited = await get();

    expect(limited.status).toBe(429);
    expect(errorOf(limited).code).toBe("RATE_LIMITED");
  });
});

describe("triggers", () => {
  it("leaves the climate trigger waiting while nothing is connected", async () => {
    const { create } = setup();

    const business = await create();

    expect(business.scoring).toBe("pending");
    const jobs = await prisma.inputTriggerJob.findMany();
    expect(jobs).toMatchObject([
      { businessId: business.id, kind: "climate_warm", status: "pending", attempts: 0, payload: { lat: 19.076, lon: 72.8777 } },
    ]);
  });

  it("warms the climate cache for the primary location", async () => {
    const { ports, calls } = fakePorts();
    const { create } = setup({ ports });

    const business = await create();

    expect(calls).toEqual([{ port: "climate.warm", input: { lat: 19.076, lon: 72.8777 } }]);
    expect(business.scoring).toBe("ok");
    expect(await prisma.inputTriggerJob.findFirst()).toMatchObject({ status: "done", attempts: 1 });
  });

  it("accepts the input when the climate unit fails, and retries later", async () => {
    const { ports, calls, state } = fakePorts();
    const { app, create, service } = setup({ ports });
    state.failing = true;

    const business = await create();

    expect(business.scoring).toBe("pending");
    expect(await prisma.inputTriggerJob.findFirst()).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "climate.warm down",
    });

    state.failing = false;
    expect(await service.retryPending()).toMatchObject({ jobs: 1 });

    expect(calls).toHaveLength(2);
    const after = await signedIn(app).get(`/businesses/${business.id}`);
    expect((after.body as BusinessDetail).scoring).toBe("ok");
  });

  it("stops waiting for a service that does not answer", async () => {
    const { ports, state } = fakePorts();
    const { create } = setup({ ports });
    state.hanging = true;

    const business = await create();

    expect(business.scoring).toBe("pending");
    const job = await prisma.inputTriggerJob.findFirst();
    expect(job?.lastError).toContain("timed out");
  });

  it("retries what a business is still owed on its next save", async () => {
    const { ports, calls, state } = fakePorts();
    const { create, send } = setup({ ports });
    state.failing = true;
    const business = await create();
    state.failing = false;

    const res = await send("patch", `/businesses/${business.id}`, { profile: { employees: 9 } });

    expect((res.body as BusinessDetail).scoring).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});

describe("GET /businesses/:id", () => {
  it("returns the business with its latest snapshot and loans", async () => {
    const { app, create, send } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    await send("post", `/businesses/${id}/snapshots`, financialsBody({ cash_balance: 1 }));
    await send("post", `/businesses/${id}/loans`, loanBody(), BANK);

    const res = await signedIn(app).get(`/businesses/${id}`);

    expect(res.status).toBe(200);
    const body = res.body as BusinessDetail;
    expect(body.latest_snapshot).toMatchObject({ version: 2, raw: { cash_balance: 1 } });
    expect(body.loans).toMatchObject([{ status: "applied", amount: 500_000 }]);
    expect(body.impact_profile).toMatchObject({ version: 1 });
  });

  it("needs a signed-in user on every route", async () => {
    const { app, create } = setup();
    const { id } = await create();
    const key = (req: request.Test) => req.set("Idempotency-Key", `anon-${String((keys += 1))}`);

    const results = await Promise.all([
      key(request(app).post("/businesses")).send(businessBody()),
      request(app).get(`/businesses/${id}`),
      request(app).get(`/businesses/${id}/snapshots`),
      request(app).get(`/businesses/${id}/impact-profile`),
      key(request(app).patch(`/businesses/${id}`)).send({ profile: { employees: 1 } }),
      key(request(app).post(`/businesses/${id}/snapshots`)).send(financialsBody()),
      key(request(app).patch("/loans/nope/status")).send({ status: "authorised" }),
      key(request(app).post("/seed/smes")),
    ]);

    for (const res of results) {
      expect(res.status).toBe(401);
      expect(errorOf(res).code).toBe("UNAUTHORIZED");
    }
    expect(await prisma.business.count()).toBe(1);
  });

  it("lets an owner reach only the businesses they created", async () => {
    const { app, create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}`;

    const results = await Promise.all([
      signedIn(app, OTHER_OWNER).get(path),
      signedIn(app, OTHER_OWNER).get(`${path}/snapshots`),
      signedIn(app, OTHER_OWNER).get(`${path}/impact-profile`),
      send("patch", path, { profile: { employees: 1 } }, STRANGER),
      send("put", `${path}/locations`, businessBody().locations as object, STRANGER),
      send("put", `${path}/suppliers`, { suppliers: businessBody().suppliers }, STRANGER),
      send("post", `${path}/snapshots`, financialsBody(), STRANGER),
    ]);

    // The same answer as for a business that does not exist
    for (const res of results) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("BUSINESS_NOT_FOUND");
    }
    expect((await signedIn(app).get(path)).status).toBe(200);
    expect((await signedIn(app, BANK_USER).get(path)).status).toBe(200);
    expect(await prisma.financialSnapshot.count()).toBe(0);
  });

  it("hides a business from the bank until its owner agrees to share it", async () => {
    const { app, create, send } = setup();
    const { id } = await create({
      consent: { data_processing: true, share_with_bank: false, alerts: true },
    });
    const path = `/businesses/${id}`;

    const results = await Promise.all([
      signedIn(app, BANK_USER).get(path),
      signedIn(app, BANK_USER).get(`${path}/snapshots`),
      send("post", `${path}/loans`, loanBody(), BANK),
      send("patch", path, { profile: { employees: 1 } }, BANK),
    ]);

    for (const res of results) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("BUSINESS_NOT_FOUND");
    }
    expect((await signedIn(app).get(path)).status).toBe(200);
    expect(await prisma.loan.count()).toBe(0);
  });

  it("lets the owner withdraw sharing, which hides the business from the bank at once", async () => {
    const { app, create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}`;
    expect((await signedIn(app, BANK_USER).get(path)).status).toBe(200);

    const res = await send("patch", `${path}/consent`, { share_with_bank: false });

    expect(res.status).toBe(200);
    expect((res.body as BusinessDetail).consent).toMatchObject({
      data_processing: true,
      share_with_bank: false,
      timestamp: NOW.toISOString(),
      version: INPUT.consentVersion,
    });
    expect((await signedIn(app, BANK_USER).get(path)).status).toBe(404);
    // And can give it again
    expect((await send("patch", `${path}/consent`, { share_with_bank: true })).status).toBe(200);
    expect((await signedIn(app, BANK_USER).get(path)).status).toBe(200);
  });

  it("keeps consent to its owner and refuses to withdraw sharing under a live loan", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}/consent`;
    const loan = (await send("post", `/businesses/${id}/loans`, loanBody(), BANK)).body as { loan: LoanView };
    await send("patch", `/loans/${loan.loan.id}/status`, { status: "authorised" }, BANK);

    const bank = await send("patch", path, { share_with_bank: false }, BANK);
    const stranger = await send("patch", path, { share_with_bank: false }, STRANGER);
    const locked = await send("patch", path, { share_with_bank: false });
    const alertsOff = await send("patch", path, { alerts: false });
    const empty = await send("patch", path, {});
    const processing = await send("patch", path, { data_processing: false });

    expect(bank.status).toBe(403);
    expect(stranger.status).toBe(404);
    expect(locked.status).toBe(409);
    expect(errorOf(locked).code).toBe("CONSENT_LOCKED_BY_LOAN");
    expect(alertsOff.status).toBe(200);
    expect((alertsOff.body as BusinessDetail).consent).toMatchObject({ share_with_bank: true, alerts: false });
    expect(empty.status).toBe(422);
    expect(processing.status).toBe(422);
  });

  it("records the owner, and leaves a bank-created business to the bank", async () => {
    const { app, create, send } = setup();
    const mine = await create();
    const banks = await send("post", "/businesses", businessBody(), BANK);

    const rows = await prisma.business.findMany({ select: { id: true, ownerUserId: true } });
    expect(rows.find((row) => row.id === mine.id)?.ownerUserId).toBe(OWNER.id);
    expect(rows.find((row) => row.id === (banks.body as BusinessDetail).id)?.ownerUserId).toBeNull();
    expect((await signedIn(app).get(`/businesses/${(banks.body as BusinessDetail).id}`)).status).toBe(404);
  });

  it("answers 404 BUSINESS_NOT_FOUND for an unknown id", async () => {
    const { app, send } = setup();
    const missing = "/businesses/00000000-0000-0000-0000-000000000000";

    const results = await Promise.all([
      signedIn(app).get(missing),
      signedIn(app).get(`${missing}/snapshots`),
      signedIn(app).get(`${missing}/impact-profile`),
      send("patch", missing, { profile: { employees: 1 } }),
      send("put", `${missing}/locations`, businessBody().locations as object),
      send("put", `${missing}/suppliers`, { suppliers: businessBody().suppliers }),
      send("post", `${missing}/snapshots`, financialsBody()),
      send("post", `${missing}/loans`, loanBody(), BANK),
    ]);

    for (const res of results) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("BUSINESS_NOT_FOUND");
    }
  });
});

describe("PATCH /businesses/:id", () => {
  it("merges the fields sent into the stored groups", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send("patch", `/businesses/${id}`, {
      profile: { employees: 9, sub_sector: "dessert shop" },
      operations: { power_outage_hrs_month: 30 },
      contacts: { alerts: { channels: ["email"] } },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      profile: { name: "Sharma Cold Drinks", employees: 9, sub_sector: "dessert shop" },
      operations: { power_outage_hrs_month: 30, has_insurance: true, seasonal_months: [3, 4, 5] },
      contacts: { owner: { name: "Ravi Sharma" }, alerts: { channels: ["email"] } },
    });
    expect((res.body as BusinessDetail).contacts.alerts).not.toHaveProperty("quiet_hours");
    expect(await prisma.business.findUnique({ where: { id } })).toMatchObject({ name: "Sharma Cold Drinks" });
  });

  it("runs the cross-field checks on the merged result", async () => {
    const { create, send } = setup();
    const { id } = await create();

    // The stored business still lists what its insurance covers
    const res = await send("patch", `/businesses/${id}`, { operations: { has_insurance: false } });

    expect(res.status).toBe(422);
    expect(fieldsOf(res)).toHaveProperty(["operations.insurance_covers"]);

    const cleared = await send("patch", `/businesses/${id}`, {
      operations: { has_insurance: false, insurance_covers: [] },
    });
    expect(cleared.status).toBe(200);
  });

  it("refuses an empty patch, unknown groups and invalid values", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const empty = await send("patch", `/businesses/${id}`, {});
    const consent = await send("patch", `/businesses/${id}`, { consent: { data_processing: false } });
    const invalid = await send("patch", `/businesses/${id}`, { profile: { sector: "banking" } });

    expect([empty.status, consent.status, invalid.status]).toEqual([422, 422, 422]);
    expect(fieldsOf(invalid)).toHaveProperty(["profile.sector"]);
  });
});

describe("PUT /businesses/:id/locations", () => {
  it("replaces the locations and triggers the climate unit for the new primary", async () => {
    const { ports, calls } = fakePorts();
    const { create, send } = setup({ ports });
    const { id } = await create();

    const res = await send("put", `/businesses/${id}/locations`, {
      primary: { lat: 18.5204, lon: 73.8567, address: "FC Road, Pune", pincode: "411004" },
      additional_locations: [{ lat: 19.076, lon: 72.8777, address: "Old shop, Mumbai" }],
    });

    expect(res.status).toBe(200);
    expect((res.body as BusinessDetail).locations).toEqual({
      primary: { lat: 18.5204, lon: 73.8567, address: "FC Road, Pune", pincode: "411004" },
      additional_locations: [{ lat: 19.076, lon: 72.8777, address: "Old shop, Mumbai" }],
    });
    expect(calls.at(-1)).toEqual({ port: "climate.warm", input: { lat: 18.5204, lon: 73.8567 } });
    expect(await prisma.businessLocation.count({ where: { businessId: id } })).toBe(2);
  });

  it("keeps a single waiting climate trigger, for the latest location", async () => {
    const { create, send } = setup();
    const { id } = await create();

    await send("put", `/businesses/${id}/locations`, {
      primary: { lat: 18.5204, lon: 73.8567, address: "FC Road, Pune", pincode: "411004" },
    });

    const jobs = await prisma.inputTriggerJob.findMany({ where: { businessId: id } });
    expect(jobs).toMatchObject([{ kind: "climate_warm", payload: { lat: 18.5204, lon: 73.8567 } }]);
  });

  it("refuses invalid locations and leaves the stored ones alone", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send("put", `/businesses/${id}/locations`, {
      primary: { lat: 51.5, lon: -0.12, address: "London", pincode: "400014" },
    });

    expect(res.status).toBe(422);
    expect(fieldsOf(res)).toHaveProperty("primary");
    expect(await prisma.businessLocation.findFirst({ where: { businessId: id } })).toMatchObject({ lat: 19.076 });
  });
});

describe("PUT /businesses/:id/suppliers", () => {
  it("replaces the supplier list", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send("put", `/businesses/${id}/suppliers`, {
      suppliers: [{ name: "New Dairy", lat: 19.1, lon: 72.9, share: 1 }],
    });

    expect(res.status).toBe(200);
    expect((res.body as BusinessDetail).suppliers).toEqual([
      { name: "New Dairy", lat: 19.1, lon: 72.9, share: 1, critical: false },
    ]);
  });

  it("refuses shares that do not sum to 1.0", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send("put", `/businesses/${id}/suppliers`, {
      suppliers: [{ name: "Half", lat: 19.1, lon: 72.9, share: 0.5 }],
    });

    expect(res.status).toBe(422);
    expect(fieldsOf(res)).toEqual({ suppliers: "shares sum to 0.50, must be 1.0" });
    expect(await prisma.businessSupplier.count({ where: { businessId: id } })).toBe(2);
  });
});

describe("snapshots", () => {
  it("stores the raw numbers next to the derived ratios", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send("post", `/businesses/${id}/snapshots`, financialsBody());

    expect(res.status).toBe(201);
    const { snapshot } = res.body as { snapshot: SnapshotView };
    expect(snapshot).toMatchObject({
      version: 1,
      as_of: "2026-09-30",
      raw: financialsBody(),
      derived: {
        avg_revenue: 100_000,
        revenue_volatility: 0.1291,
        NOI_month: 40_000,
        operating_margin: 0.4,
        debt_service_month: 10_000,
        dscr: 4,
        debt_to_revenue: 0.2,
        cash_buffer_days: 45,
        years_in_operation: 11,
        num_locations: 1,
      },
      derivation_version: INPUT.derivationVersion,
      verified_by_bank: false,
    });
  });

  it("appends a new version on every submission and never rewrites an old one", async () => {
    const { app, create, send } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    await send("post", `/businesses/${id}/snapshots`, financialsBody({ cash_balance: 5 }));

    const res = await signedIn(app).get(`/businesses/${id}/snapshots`);

    const { snapshots } = res.body as { snapshots: SnapshotView[] };
    expect(snapshots.map((snapshot) => [snapshot.version, snapshot.raw.cash_balance])).toEqual([
      [2, 5],
      [1, 90_000],
    ]);
  });

  it("gives concurrent submissions distinct versions", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const results = await Promise.all(
      [1, 2, 3, 4].map(() => send("post", `/businesses/${id}/snapshots`, financialsBody())),
    );

    const versions = results.map((res) => (res.body as { snapshot: SnapshotView }).snapshot.version);
    expect(versions.sort()).toEqual([1, 2, 3, 4]);
  });

  it("rejects a revenue history of zeros as INVALID_FINANCIALS", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const res = await send(
      "post",
      `/businesses/${id}/snapshots`,
      financialsBody({ monthly_revenue: [0, 0, 0, 0, 0, 0] }),
    );

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("INVALID_FINANCIALS");
    expect(await prisma.financialSnapshot.count()).toBe(0);
  });

  it("refuses too short a history, a future date and a self-declared verification", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}/snapshots`;

    const short = await send("post", path, financialsBody({ monthly_revenue: [1, 2, 3, 4, 5] }));
    const future = await send("post", path, financialsBody({ as_of: "2026-10-10" }));
    const verified = await send("post", path, financialsBody({ verified_by_bank: true }));

    expect([short.status, future.status, verified.status]).toEqual([422, 422, 422]);
    expect(fieldsOf(short)).toHaveProperty("monthly_revenue");
    expect(fieldsOf(future)).toEqual({ as_of: "as_of cannot be in the future" });
    expect(await prisma.financialSnapshot.count()).toBe(0);
  });

  it("adds the EMI of a loan that is applied for to the debt service", async () => {
    const { create, send } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/loans`, loanBody({ emi: 10_000 }), BANK);

    const res = await send("post", `/businesses/${id}/snapshots`, financialsBody());

    expect((res.body as { snapshot: SnapshotView }).snapshot.derived).toMatchObject({
      debt_service_month: 20_000,
      proposed_loan_emi: 10_000,
      dscr: 2,
    });
  });

  it("lets only the bank mark a snapshot verified", async () => {
    const { create, send } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    const path = `/businesses/${id}/snapshots/1/verify`;

    const owner = await send("post", path);
    // The role comes from the session; a caller cannot claim it
    const claimedBank = await send("post", path, undefined, { "X-Actor-Role": "bank", "X-Actor-Id": "x" });
    const bank = await send("post", path, undefined, BANK);

    expect(owner.status).toBe(403);
    expect(errorOf(owner).code).toBe("FORBIDDEN");
    expect(claimedBank.status).toBe(403);
    expect(bank.status).toBe(200);
    expect(bank.body).toMatchObject({
      version: 1,
      verified_by_bank: true,
      verified_by: "officer-7",
      verified_at: NOW.toISOString(),
      raw: financialsBody(),
    });
  });

  it("answers 404 SNAPSHOT_NOT_FOUND for a version that does not exist", async () => {
    const { create, send } = setup();
    const { id } = await create();

    for (const version of ["2", "0", "abc"]) {
      const res = await send("post", `/businesses/${id}/snapshots/${version}/verify`, undefined, BANK);
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe("SNAPSHOT_NOT_FOUND");
    }
  });
});

describe("loans", () => {
  const loanOf = (res: request.Response) => (res.body as { loan: LoanView }).loan;

  it("is entered by the bank, with status applied", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const owner = await send("post", `/businesses/${id}/loans`, loanBody());
    const bank = await send("post", `/businesses/${id}/loans`, loanBody(), BANK);

    expect(owner.status).toBe(403);
    expect(bank.status).toBe(201);
    expect(loanOf(bank)).toMatchObject({
      business_id: id,
      amount: 500_000,
      emi: 10_000,
      tenure_months: 60,
      interest_rate: 11.5,
      purpose: "equipment",
      status: "applied",
    });
  });

  it("needs the owner's consent to share with the bank", async () => {
    const { send } = setup();
    const consent = { data_processing: true, share_with_bank: false, alerts: true };
    const entered = await send("post", "/businesses", businessBody({ consent }), BANK);
    const { id } = entered.body as BusinessDetail;

    const res = await send("post", `/businesses/${id}/loans`, loanBody(), BANK);

    expect(res.status).toBe(403);
    expect(errorOf(res).code).toBe("CONSENT_REQUIRED");
    expect(await prisma.loan.count()).toBe(0);
  });

  it("locks the profile, operations, locations and suppliers to the owner once a loan is authorised", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}`;
    const loan = loanOf(await send("post", `${path}/loans`, loanBody(), BANK));
    const locations = {
      ...(businessBody().locations as object),
      primary: { lat: 28.6139, lon: 77.209, address: "Somewhere drier", pincode: "110001" },
    };

    // A loan that is only applied for locks nothing
    expect((await send("patch", path, { profile: { employees: 9 } })).status).toBe(200);
    await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);

    const refused = await Promise.all([
      send("patch", path, { profile: { sector: "retail" } }),
      send("patch", path, { operations: { has_insurance: true } }),
      send("put", `${path}/locations`, locations),
      send("put", `${path}/suppliers`, { suppliers: businessBody().suppliers }),
    ]);
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(errorOf(res).code).toBe("LOCKED_BY_LOAN");
    }
    const stored = await prisma.businessLocation.findFirst({ where: { businessId: id, isPrimary: true } });
    expect(stored).toMatchObject({ lat: 19.076, lon: 72.8777 });

    // The owner's own contact details stay theirs to change, and the bank can change the rest
    const contacts = await send("patch", path, { contacts: { alerts: { channels: ["email"] } } });
    const byBank = await send("put", `${path}/locations`, locations, BANK);
    expect(contacts.status).toBe(200);
    expect(byBank.status).toBe(200);
    expect((byBank.body as BusinessDetail).locations.primary).toMatchObject({ lat: 28.6139, lon: 77.209 });

    // Unlocked again when the loan has ended
    await send("patch", `/loans/${loan.id}/status`, { status: "rejected" }, BANK);
    expect((await send("patch", path, { profile: { employees: 10 } })).status).toBe(200);
  });

  it("refuses an invalid loan", async () => {
    const { create, send } = setup();
    const { id } = await create();

    const bad = await send("post", `/businesses/${id}/loans`, loanBody({ tenure_months: 0 }), BANK);
    const emi = await send("post", `/businesses/${id}/loans`, loanBody({ amount: 5_000 }), BANK);

    expect(fieldsOf(bad)).toHaveProperty("tenure_months");
    expect(fieldsOf(emi)).toEqual({ emi: "emi cannot be more than the loan amount" });
  });

  it("moves forward one status at a time", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    const move = (status: string) => send("patch", `/loans/${loan.id}/status`, { status }, BANK);

    const skipped = await move("active");
    expect(skipped.status).toBe(409);
    expect(errorOf(skipped)).toMatchObject({
      code: "INVALID_STATUS_TRANSITION",
      details: { from: "applied", to: "active", allowed: ["authorised", "rejected"] },
    });

    for (const status of ["authorised", "active", "closed"]) {
      const res = await move(status);
      expect(res.status).toBe(200);
      expect(loanOf(res).status).toBe(status);
    }

    for (const status of ["active", "applied", "rejected", "closed"]) {
      expect((await move(status)).status).toBe(409);
    }
  });

  it("can reject an applied or authorised loan, and a rejected loan is final", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const move = (loanId: string, status: string) => send("patch", `/loans/${loanId}/status`, { status }, BANK);
    const applied = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    const authorised = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    await move(authorised.id, "authorised");

    expect((await move(applied.id, "rejected")).status).toBe(200);
    expect((await move(authorised.id, "rejected")).status).toBe(200);
    expect((await move(applied.id, "authorised")).status).toBe(409);
  });

  it("lets only one of two racing transitions win", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));

    const results = await Promise.all(
      ["authorised", "rejected"].map((status) => send("patch", `/loans/${loan.id}/status`, { status }, BANK)),
    );

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  });

  it("is changed by the bank only, and validates the status", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));

    const owner = await send("patch", `/loans/${loan.id}/status`, { status: "authorised" });
    const unknown = await send("patch", `/loans/${loan.id}/status`, { status: "approved" }, BANK);
    const missing = await send("patch", "/loans/nope/status", { status: "authorised" }, BANK);

    expect(owner.status).toBe(403);
    expect(unknown.status).toBe(422);
    expect(missing.status).toBe(404);
    expect(errorOf(missing).code).toBe("LOAN_NOT_FOUND");
  });

  it("asks finance for a first profile when a loan is authorised", async () => {
    const { ports, calls } = fakePorts();
    const { create, send } = setup({ ports });
    const { id } = await create();
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));

    const res = await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);

    expect(calls.at(-1)).toEqual({ port: "finance.firstProfile", input: { businessId: id, loanId: loan.id } });
    expect((res.body as { scoring: string }).scoring).toBe("ok");
  });

  it("asks finance to recompute when a snapshot arrives for a live loan", async () => {
    const { ports, calls } = fakePorts();
    const { create, send } = setup({ ports });
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    expect(calls.map((call) => call.port)).toEqual(["climate.warm"]);
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);
    await send("patch", `/loans/${loan.id}/status`, { status: "active" }, BANK);

    const res = await send("post", `/businesses/${id}/snapshots`, financialsBody());

    expect(calls.at(-1)).toEqual({ port: "finance.recompute", input: { businessId: id, snapshotVersion: 2 } });
    // An active loan is already inside existing_emi_total
    expect((res.body as { snapshot: SnapshotView }).snapshot.derived.proposed_loan_emi).toBe(0);
  });

  it("scores from the verified snapshot: an owner's later, unverified numbers do not rescore", async () => {
    const { ports, calls } = fakePorts();
    const { create, send, service } = setup({ ports });
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    await send("post", `/businesses/${id}/snapshots/1/verify`, undefined, BANK);
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);
    await send("patch", `/loans/${loan.id}/status`, { status: "active" }, BANK);
    const before = calls.length;

    const res = await send("post", `/businesses/${id}/snapshots`, financialsBody());
    const business = await service.getBusiness(id);

    expect(res.status).toBe(201);
    expect(calls.slice(before).map((call) => call.port)).not.toContain("finance.recompute");
    expect(business.latest_snapshot).toMatchObject({ version: 2, verified_by_bank: false });
    expect(business.scoring_snapshot).toMatchObject({ version: 1, verified_by_bank: true });
  });

  it("rescores a live loan when the bank verifies newer numbers, once", async () => {
    const { ports, calls } = fakePorts();
    const { create, send, service } = setup({ ports });
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    await send("post", `/businesses/${id}/snapshots/1/verify`, undefined, BANK);
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);
    await send("patch", `/loans/${loan.id}/status`, { status: "active" }, BANK);
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    const before = calls.length;

    await send("post", `/businesses/${id}/snapshots/2/verify`, undefined, BANK);
    await send("post", `/businesses/${id}/snapshots/2/verify`, undefined, BANK);
    const business = await service.getBusiness(id);

    expect(calls.slice(before)).toEqual([
      { port: "finance.recompute", input: { businessId: id, snapshotVersion: 2 } },
    ]);
    expect(business.scoring_snapshot).toMatchObject({ version: 2, verified_by_bank: true });
  });

  it("lists the locations with an authorised or active loan as active cells", async () => {
    const { create, send, service } = setup();
    const { id } = await create();
    await create();
    const loan = loanOf(await send("post", `/businesses/${id}/loans`, loanBody(), BANK));
    const move = (status: string) => send("patch", `/loans/${loan.id}/status`, { status }, BANK);
    const active = [{ business_id: id, lat: 19.076, lon: 72.8777 }];

    expect(await service.activeLocations()).toEqual([]);
    await move("authorised");
    expect(await service.activeLocations()).toEqual(active);
    await move("active");
    expect(await service.activeLocations()).toEqual(active);
    await move("closed");
    expect(await service.activeLocations()).toEqual([]);
  });
});

describe("weather-impact profile", () => {
  it("is pending while the classifier runs and does not block the save", async () => {
    const { llm, hold } = fakeLlm();
    const release = hold();
    const { app, create, profile } = setup({ llm });

    const business = await create();

    expect(business.impact_profile).toMatchObject({ version: 1, status: "pending", conditions: null });
    const pending = await signedIn(app).get(`/businesses/${business.id}/impact-profile`);
    expect(pending.body).toMatchObject({ status: "pending" });

    release();
    expect(await profile(business.id)).toMatchObject({
      business_id: business.id,
      version: 1,
      status: "ok",
      category: "food_beverage",
      overall_confidence: 0.8,
      model: "fake-model",
      prompt_version: INPUT.classifier.promptVersion,
      conditions: { heat: { physical: 0.2, demand: 0.7, source: "llm" } },
    });
  });

  it("never sends the model names, contacts, coordinates, IDs or financials", async () => {
    const { llm, requests } = fakeLlm();
    const { create, profile } = setup({ llm });

    const { id } = await create();
    await profile(id);

    expect(JSON.parse(requests[0]?.user ?? "")).toEqual({
      sector: "food_beverage",
      sub_sector: "ice cream parlour",
      description: "Ground-floor ice cream and cold drinks shop for walk-in families and students.",
      products: ["ice cream", "cold drinks"],
      sales_channel: "walk_in",
      indoor_outdoor: "indoor",
      seasonal_months: [3, 4, 5],
      city: "Mumbai",
      state: "Maharashtra",
    });
  });

  it("keeps the raw reply and applies the guardrails to what is served", async () => {
    const reply = validReply();
    reply.conditions.river_flood.physical = 0;
    reply.conditions.drought.confidence = 0.2;
    const { create, profile } = setup({ llm: fakeLlm([reply]).llm });

    const { id } = await create();
    const served = await profile(id);

    expect(served.conditions?.river_flood).toMatchObject({ physical: 0.3, source: "llm" });
    expect(served.conditions?.drought).toMatchObject({ physical: 0.15, source: "sector_default" });
    const row = await prisma.weatherImpactProfile.findFirst({ where: { businessId: id } });
    expect(row?.rawOutput).toEqual(reply);
  });

  it("falls back to the sector defaults when the model is down", async () => {
    const { llm, state } = fakeLlm();
    state.failing = true;
    const { create, profile } = setup({ llm });

    const { id } = await create();
    const served = await profile(id);

    expect(served).toMatchObject({ status: "fallback", category: "food_beverage", note: "classifier unavailable: model down" });
    expect(Object.values(served.conditions ?? {}).map((condition) => condition.demand)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("falls back when no model is configured", async () => {
    const { create, profile } = setup();

    const { id } = await create();

    expect(await profile(id)).toMatchObject({ status: "fallback", model: null, note: "classifier is not configured" });
  });

  it("reruns only when a field the classifier reads changes", async () => {
    const { llm, requests } = fakeLlm();
    const { create, send, profile } = setup({ llm });
    const { id } = await create();
    await profile(id);

    await send("patch", `/businesses/${id}`, { profile: { name: "Sharma & Sons", employees: 7 } });
    await send("patch", `/businesses/${id}`, { contacts: { alerts: { channels: ["sms"] } } });
    await send("put", `/businesses/${id}/suppliers`, { suppliers: [{ name: "S", lat: 19, lon: 73, share: 1 }] });
    expect(await profile(id)).toMatchObject({ version: 1 });
    expect(requests).toHaveLength(1);

    await send("patch", `/businesses/${id}`, { profile: { description: "Now a delivery-only kitchen selling biryani through apps." } });
    expect(await profile(id)).toMatchObject({ version: 2, status: "ok" });

    await send("patch", `/businesses/${id}`, { operations: { seasonal_months: [10, 11] } });
    expect(await profile(id)).toMatchObject({ version: 3 });

    // A PIN code in another city changes the city the model is given
    await send("put", `/businesses/${id}/locations`, {
      primary: { lat: 18.5204, lon: 73.8567, address: "FC Road, Pune", pincode: "411004" },
    });
    expect(await profile(id)).toMatchObject({ version: 4 });
    expect(requests).toHaveLength(4);
    expect(await prisma.weatherImpactProfile.count({ where: { businessId: id } })).toBe(4);
  });

  it("reuses the stored reply for another business with the same inputs", async () => {
    const { llm, requests } = fakeLlm();
    const { create, profile } = setup({ llm });
    const first = await create();
    const firstProfile = await profile(first.id);

    const body = businessBody();
    const second = await create({ profile: { ...(body.profile as object), name: "A Different Shop" } });
    const secondProfile = await profile(second.id);

    expect(requests).toHaveLength(1);
    expect(secondProfile).toMatchObject({ status: "ok", inputs_hash: firstProfile.inputs_hash });
    expect(secondProfile.conditions).toEqual(firstProfile.conditions);
  });

  it("lets the bank force a rerun that bypasses the cache", async () => {
    const { llm, requests } = fakeLlm();
    const { create, send, profile } = setup({ llm });
    const { id } = await create();
    await profile(id);
    const path = `/businesses/${id}/impact-profile/reclassify`;

    expect((await send("post", path)).status).toBe(403);
    const res = await send("post", path, undefined, BANK);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ version: 2 });
    expect(await profile(id)).toMatchObject({ version: 2, status: "ok" });
    expect(requests).toHaveLength(2);
  });

  it("stores a bank override as a new version", async () => {
    const { create, send, profile } = setup({ llm: fakeLlm().llm });
    const { id } = await create();
    await profile(id);

    const res = await send(
      "put",
      `/businesses/${id}/impact-profile`,
      {
        reason: "Shop is on a raised plinth",
        category: "retail",
        conditions: { river_flood: { physical: 0.1, reason: "Raised plinth, never flooded" } },
      },
      BANK,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      version: 2,
      status: "overridden",
      category: "retail",
      overridden_by: "officer-7",
      override_reason: "Shop is on a raised plinth",
      conditions: {
        // The bank may go below the floor that binds the model
        river_flood: { physical: 0.1, demand: -0.3, reason: "Raised plinth, never flooded", source: "override" },
        heat: { physical: 0.2, demand: 0.7, source: "llm" },
      },
    });
    expect(await prisma.weatherImpactProfile.count({ where: { businessId: id } })).toBe(2);
  });

  it("keeps an override until the business itself changes", async () => {
    const { create, send, profile } = setup({ llm: fakeLlm().llm });
    const { id } = await create();
    await profile(id);
    const override = { reason: "Checked on site", conditions: { heat: { demand: 0.9 } } };
    await send("put", `/businesses/${id}/impact-profile`, override, BANK);

    await send("patch", `/businesses/${id}`, { profile: { employees: 12 } });
    expect(await profile(id)).toMatchObject({ version: 2, status: "overridden" });

    await send("patch", `/businesses/${id}`, { profile: { sector: "retail" } });
    expect(await profile(id)).toMatchObject({ version: 3, status: "ok", overridden_by: null });
  });

  it("overrides on top of the sector defaults when nothing has been classified", async () => {
    const { create, send, profile } = setup();
    const { id } = await create();
    await profile(id);

    const res = await send(
      "put",
      `/businesses/${id}/impact-profile`,
      { reason: "Known heat seller", conditions: { heat: { demand: 0.8, mechanism: "demand_mix" } } },
      BANK,
    );

    expect((res.body as ImpactProfileView).conditions).toMatchObject({
      heat: { physical: 0.15, demand: 0.8, mechanism: "demand_mix", source: "override" },
      storm: { demand: 0, source: "sector_default" },
    });
  });

  it("refuses an override from the owner or with invalid values", async () => {
    const { create, send } = setup();
    const { id } = await create();
    const path = `/businesses/${id}/impact-profile`;
    const valid = { reason: "Checked on site", conditions: { heat: { demand: 0.9 } } };

    const owner = await send("put", path, valid);
    const range = await send("put", path, { ...valid, conditions: { heat: { physical: 2 } } }, BANK);
    const noReason = await send("put", path, { conditions: valid.conditions }, BANK);

    expect(owner.status).toBe(403);
    expect(range.status).toBe(422);
    expect(fieldsOf(range)).toHaveProperty(["conditions.heat.physical"]);
    expect(fieldsOf(noReason)).toHaveProperty("reason");
    expect(await prisma.weatherImpactProfile.count({ where: { businessId: id, status: "overridden" } })).toBe(0);
  });

  it("finishes a classification that was left pending", async () => {
    const { create, service, profile } = setup({ llm: fakeLlm().llm });
    const { id } = await create();
    await service.idle();
    // As if the process had stopped before the classifier answered
    await prisma.weatherImpactProfile.updateMany({
      data: { status: "pending", conditions: undefined, updatedAt: new Date(NOW.getTime() - 10 * 60_000) },
    });

    expect(await service.retryPending()).toMatchObject({ profiles: 1 });

    expect(await profile(id)).toMatchObject({ version: 1, status: "ok" });
  });
});

describe("audit trail", () => {
  it("names the business, snapshot or loan each change was made to, and who made it", async () => {
    const { create, send, audit } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody());
    await send("post", `/businesses/${id}/snapshots/1/verify`, undefined, BANK);
    const applied = await send("post", `/businesses/${id}/loans`, loanBody(), BANK);
    const { loan } = applied.body as { loan: LoanView };
    await send("patch", `/loans/${loan.id}/status`, { status: "authorised" }, BANK);
    await send("put", `/businesses/${id}/locations`, businessBody().locations as object);

    const owner = { actorId: OWNER.id, actorRole: "owner" };
    const bank = { actorId: BANK_USER.id, actorRole: "bank" };
    expect(audit.events).toMatchObject([
      { ...owner, action: "POST /businesses", targetType: "business", targetId: id, outcome: "success" },
      { ...owner, action: "POST /businesses/:id/snapshots", targetId: id, outcome: "success" },
      { ...bank, action: "POST /businesses/:id/snapshots/:v/verify", targetType: "snapshot", targetId: `${id}/1` },
      { ...bank, action: "POST /businesses/:id/loans", targetId: id, outcome: "success" },
      { ...bank, action: "PATCH /loans/:id/status", targetType: "loan", targetId: loan.id, outcome: "success" },
      { ...owner, action: "PUT /businesses/:id/locations", outcome: "denied", reason: "LOCKED_BY_LOAN" },
    ]);
    // What was entered is in the tables it belongs to, not in the trail
    expect(JSON.stringify(audit.events)).not.toContain("Sharma");
  });

  it("records an attempt to open someone else's business, although it is only a read", async () => {
    const { app, create, audit } = setup();
    const { id } = await create();
    audit.events.length = 0;

    await signedIn(app, OTHER_OWNER).get(`/businesses/${id}`);
    await signedIn(app).get(`/businesses/${id}`);

    expect(audit.events).toMatchObject([
      {
        actorId: OTHER_OWNER.id,
        action: `GET /businesses/${id}`,
        targetType: "business",
        targetId: id,
        outcome: "failure",
        status: 404,
        reason: "BUSINESS_NOT_FOUND",
      },
    ]);
  });
});

describe("request log", () => {
  it("records every request to the input routes", async () => {
    const { create, send, service } = setup();
    const { id } = await create();
    await send("post", `/businesses/${id}/snapshots`, financialsBody({ monthly_revenue: [] }));
    await send("post", `/businesses/${id}/loans`, loanBody(), BANK);
    await service.idle();

    const rows = await prisma.inputRequestLog.findMany({ orderBy: { id: "asc" } });

    expect(rows).toMatchObject([
      { method: "POST", route: "/businesses", status: 201, businessId: id, actorRole: "owner" },
      { method: "POST", route: "/businesses/:id/snapshots", status: 422, businessId: id, actorRole: "owner" },
      { method: "POST", route: "/businesses/:id/loans", status: 201, businessId: id, actorRole: "bank" },
    ]);
    expect(rows.every((row) => row.latencyMs >= 0)).toBe(true);
  });
});
