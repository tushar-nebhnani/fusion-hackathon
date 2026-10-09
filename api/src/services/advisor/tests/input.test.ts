import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, prisma } from "../../../config/db.js";
import { createEvaluatorService, createPrismaEvaluationStore } from "../../evaluator/index.js";
import { createFinanceService } from "../../finance/index.js";
import { createInputService, type InputService } from "../../input/service.js";
import { businessBody, financialsBody, loanBody } from "../../input/testing/fixtures.js";
import { loadAdvisorConfig } from "../config.js";
import { createAdvisor } from "../index.js";
import { createInputDirectory, revenueByCalendarMonth, weatherImpactFrom } from "../inputDirectory.js";
import { createOfflineLlm } from "../llm/offline.js";
import { createMonitorAlertBridge } from "../monitorAlerts.js";
import { createPrismaAdvisorRepository } from "../repository.js";
import { climateProfile, OWNER_STEPS } from "../testing/fixtures.js";
import { createToolRunner } from "../tools/index.js";
import { createContactBook, type Messenger, type OutgoingMessage } from "../tools/messaging.js";
import { annualRateFor, emi } from "../tools/money.js";

// The advisor on the input service's tables, against the test database
const NOW = new Date("2026-10-09T06:00:00Z");
const BANK = { role: "bank" as const, id: "bank-officer-1" };
const silent = { error: vi.fn(), warn: vi.fn() };
const services: InputService[] = [];

function input() {
  const service = createInputService({ prisma, now: () => NOW, logger: silent, triggerTimeoutMs: 100 });
  services.push(service);
  return service;
}

// A business with a snapshot and one loan in `status`
async function business(status: "applied" | "authorised" | "active" | "rejected" = "applied") {
  const service = input();
  const created = await service.createBusiness(businessBody(), { classifier: "defaults" });
  const id = created.id;
  await service.createSnapshot(id, financialsBody());
  const { loan } = await service.createLoan(id, loanBody(), BANK);
  const path = { applied: [], authorised: ["authorised"], active: ["authorised", "active"], rejected: ["rejected"] };
  for (const next of path[status]) await service.changeLoanStatus(loan.id, { status: next }, BANK);
  await service.idle();
  return { id, loanId: loan.id, service };
}

// The real evaluator, input and finance services over a stand-in climate unit
function evaluator() {
  const climate = { getProfile: () => Promise.resolve(climateProfile({ flash_flood: { relevance: "primary", score: 0.6 } })) };
  const businesses = input();
  return createEvaluatorService({
    climate,
    businesses,
    finance: createFinanceService({ prisma, businesses, climate, now: () => NOW, logger: silent }),
    store: createPrismaEvaluationStore(prisma),
    now: () => NOW,
    logger: silent,
  });
}

function advisor() {
  const sent: OutgoingMessage[] = [];
  const messenger: Messenger = {
    send(message) {
      sent.push(message);
      return Promise.resolve({ channel: "email", to: "****", status: "dry_run", provider: "dry_run" });
    },
  };
  const directory = createInputDirectory(prisma);
  const created = createAdvisor({
    repo: createPrismaAdvisorRepository(prisma),
    directory,
    evaluator: evaluator(),
    messenger,
    contacts: createContactBook(prisma),
    llm: createOfflineLlm(),
    maxIterations: 8,
    ownerSteps: () => OWNER_STEPS,
    now: () => NOW,
  });
  return { advisor: created, directory, sent };
}

async function sentOwnerAlert(businessId: string, status: "sent" | "suppressed" = "sent") {
  const row = await prisma.alertOutbox.create({
    data: {
      dedupeKey: `test-${businessId}-${status}`,
      businessId,
      audience: "owner",
      channel: "email",
      hazard: "flash_flood",
      severity: "WARNING",
      status,
      nextTryAt: NOW,
      createdAt: NOW,
      payload: {
        businessId,
        hazard: "flash_flood",
        severity: "WARNING",
        windowStart: "2026-10-10",
        windowEnd: "2026-10-11",
        evidence: "Heavy rain forecast",
        sourceRunId: "mon-test",
      },
    },
  });
  return row.id;
}

beforeEach(async () => {
  await prisma.$executeRaw`
    TRUNCATE TABLE businesses, users, evaluations, alert_outbox, alert_contacts, advisor_conversations,
      loan_states, advisor_alert_events, repayment_proposals, business_facts
    RESTART IDENTITY CASCADE`;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.idle()));
});

afterAll(async () => {
  await disconnectDb();
});

describe("input directory", () => {
  it("builds the advisor's business record from the input service's tables", async () => {
    const { id, loanId } = await business("applied");

    const record = await createInputDirectory(prisma).getBusiness(id);

    expect(record).toMatchObject({
      id,
      name: "Sharma Cold Drinks",
      ownerName: "Ravi Sharma",
      sector: "food_beverage",
      city: "Mumbai",
      state: "Maharashtra",
      lat: 19.076,
      lon: 72.8777,
      origin: "input",
      contacts: {
        ownerEmail: "ravi@example.com",
        ownerPhone: "+919876543210",
        // The bank officer the owner typed is never a recipient
        bankEmail: null,
        consent: true,
      },
      finance: { variableCostShare: 0, fixedMonthlyCosts: 60_000, otherDebtMonthly: 10_000 },
      loans: [
        { loanId, principal: 500_000, annualRatePct: 11.5, tenureMonths: 60, disbursedOn: null, initialState: "PRE_LOAN" },
      ],
      formFacts: {
        insurance: "insured for flood, stock",
        road_power_dependency: "about 12 hours of power cuts a month, has backup power",
        revenue_pattern: "seasonal, busiest in Mar, Apr, May",
      },
    });
    // Six months ending in September; the rest are the average
    expect(record?.finance.monthlyRevenue).toEqual([
      100_000, 100_000, 100_000, 80_000, 90_000, 100_000, 110_000, 120_000, 100_000, 100_000, 100_000, 100_000,
    ]);
    expect(Object.keys(record?.weatherImpact ?? {})).toHaveLength(6);
  });

  it("refuses a business with no snapshot, and leaves it out of the list", async () => {
    const service = input();
    const { id } = await service.createBusiness(businessBody(), { classifier: "defaults" });
    const directory = createInputDirectory(prisma);

    await expect(directory.getBusiness(id)).rejects.toMatchObject({ statusCode: 409, code: "NO_FINANCIALS" });
    expect(await directory.list()).toEqual([]);
  });

  it("marks an active loan ACTIVE and leaves rejected loans out", async () => {
    const active = await business("active");
    const rejected = await business("rejected");
    const directory = createInputDirectory(prisma);

    expect((await directory.findLoan(active.loanId))?.loan).toMatchObject({
      initialState: "ACTIVE",
      disbursedOn: "2026-10-09",
    });
    expect(await directory.findLoan(rejected.loanId)).toBeNull();
  });
});

describe("advisor on input businesses", () => {
  it("moves a loan to ACTIVE once the bank marks it active in the input service", async () => {
    const { id, loanId, service } = await business("authorised");
    const { advisor: subject } = advisor();
    expect((await subject.getLoanState(loanId)).state).toBe("PRE_LOAN");

    await service.changeLoanStatus(loanId, { status: "active" }, BANK);

    expect((await subject.getLoanState(loanId)).state).toBe("ACTIVE");
    expect(await subject.businessOfLoan(loanId)).toBe(id);
  });

  it("does not message an owner who opted out in alert_contacts", async () => {
    const { id } = await business();
    await prisma.alertContact.create({
      data: { businessId: id, audience: "owner", email: "ravi@example.com", consentAt: NOW, optedOutAt: NOW },
    });
    const record = await createInputDirectory(prisma).getBusiness(id);

    const contacts = await createContactBook(prisma).forBusiness(record!);

    expect(contacts).toMatchObject({ ownerEmail: null, ownerPhone: null });
  });
});

describe("evaluation tool", () => {
  it("gives the chatbot the evaluated climate and finance answers with the business's own figures", async () => {
    const { id } = await business();
    const record = (await createInputDirectory(prisma).getBusiness(id))!;
    const repo = createPrismaAdvisorRepository(prisma);
    const conversation = await repo.createConversation({ businessId: id, loanId: null, mode: "preLoan" });
    const runner = createToolRunner(
      { repo, evaluator: evaluator(), messenger: { send: () => Promise.reject(new Error("not used")) } },
      { conversationId: conversation.id, business: record, loan: null, loanState: null, alertId: null, now: NOW },
      1,
    );

    const first = await runner.run("getEvaluation", {}, "code");
    const second = await runner.run("getEvaluation", {}, "code");

    expect(first.error).toBeUndefined();
    expect(first.output).toMatchObject({
      business_id: id,
      reliable: true,
      climate: { grade: "C" },
      finance: { origin: "computed", snapshot_version: 1 },
      business: { source: "input service: latest financial snapshot", fixedMonthlyCosts: 60_000 },
    });
    // The second turn reuses the stored finance profile instead of adding one
    expect(second.output).toMatchObject({ finance: { origin: "reused" } });
    expect(await prisma.financeProfile.count({ where: { businessId: id } })).toBe(1);
    expect(await prisma.evaluation.count({ where: { businessId: id } })).toBe(2);
  });
});

describe("monitor alerts to the advisor", () => {
  it("advises once on each owner alert the alert system sent, for live loans only", async () => {
    const live = await business("active");
    const pending = await business("applied");
    await sentOwnerAlert(live.id);
    await sentOwnerAlert(live.id, "suppressed");
    await sentOwnerAlert(pending.id);
    const { advisor: subject, directory, sent } = advisor();
    const bridge = createMonitorAlertBridge({ prisma, advisor: subject, directory, now: () => NOW, logger: silent });

    expect(await bridge.poll()).toBe(1);
    expect((await subject.getLoanState(live.loanId)).state).toBe("ALERT");
    expect(sent.some((message) => message.to === "ravi@example.com")).toBe(true);

    // Already advised on: nothing new
    expect(await bridge.poll()).toBe(0);
  });
});

describe("mapping helpers", () => {
  it("places revenue in calendar months, wrapping across the year", () => {
    const months = revenueByCalendarMonth([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "2026-03-31");
    // The twelfth value is March; the first is April a year earlier
    expect(months).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("turns classifier conditions into effects and losses", () => {
    const base = { mechanism: "foot_traffic" as const, confidence: 0.8, reason: "r", source: "llm" as const };
    const impact = weatherImpactFrom({
      river_flood: { ...base, physical: 0.6, demand: -0.3 },
      flash_flood: { ...base, physical: 0, demand: 0.4 },
      heat: { ...base, physical: 0, demand: 0 },
      drought: { ...base, physical: 0.9, demand: -0.5 },
      storm: { ...base, physical: 0.2, demand: 0 },
      cold_wave: { ...base, physical: 0, demand: -0.1 },
    });
    expect(impact).toMatchObject({
      river_flood: { effect: "unfavourable", sensitivity: 0.9 },
      flash_flood: { effect: "favourable", sensitivity: 0 },
      heat: { effect: "neutral", sensitivity: 0 },
      drought: { effect: "unfavourable", sensitivity: 1 },
      storm: { effect: "unfavourable", sensitivity: 0.2 },
      cold_wave: { effect: "unfavourable", sensitivity: 0.1 },
    });
  });

  it("finds the rate an EMI implies", () => {
    expect(annualRateFor(500_000, emi(500_000, 11.5, 60), 60)).toBeCloseTo(11.5, 1);
    expect(annualRateFor(120_000, 10_000, 12)).toBe(0);
  });
});

describe("advisor settings", () => {
  it("never serves the demo businesses in production", () => {
    expect(loadAdvisorConfig({}).demoBusinesses).toBe(true);
    expect(loadAdvisorConfig({ ADVISOR_DEMO_BUSINESSES: "false" }).demoBusinesses).toBe(false);
    expect(loadAdvisorConfig({ NODE_ENV: "production", ADVISOR_DEMO_BUSINESSES: "true" }).demoBusinesses).toBe(false);
  });

  it("advises on monitor alerts unless turned off", () => {
    expect(loadAdvisorConfig({}).monitorAlerts).toBe(true);
    expect(loadAdvisorConfig({ ADVISOR_MONITOR_ALERTS: "false" }).monitorAlerts).toBe(false);
  });
});
