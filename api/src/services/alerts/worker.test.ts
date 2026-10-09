import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, prisma } from "../../config/db.js";
import { loadAlertsConfig, type AlertsConfig } from "./config.js";
import { createEnqueue } from "./enqueue.js";
import { createAlertReader } from "./reader.js";
import { loadContent } from "./render.js";
import type { OutboundMessage, Sender } from "./senders/Sender.js";
import type { AlertEvent } from "./types.js";
import { createAlertWorker } from "./worker.js";

// Integration tests against the real test database, with a fake email
// provider and a controllable clock. 06:00 UTC is 11:30 IST.
const START = new Date("2026-10-09T06:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const content = loadContent();
let clock = START;

const EVENT: AlertEvent = {
  businessId: "SME-0142",
  hazard: "flood",
  severity: "WARNING",
  windowStart: "2026-10-12",
  windowEnd: "2026-10-14",
  evidence: "Heavy-rain tripwire crossed; river discharge rising",
  sourceRunId: "mon-2026-10-09T11:30",
};

function fakeSender() {
  const sent: OutboundMessage[] = [];
  let failing = false;
  const sender: Sender = {
    provider: "smtp",
    send(message) {
      if (failing) return Promise.reject(new Error("smtp is down"));
      sent.push(message);
      return Promise.resolve({ providerRef: `smtp-${sent.length}` });
    },
  };
  return {
    sender,
    sent,
    fail(value: boolean) {
      failing = value;
    },
  };
}

function setup(config: AlertsConfig = loadAlertsConfig({})) {
  const email = fakeSender();
  const worker = (workerId = "worker-a") =>
    createAlertWorker({
      prisma,
      config,
      content,
      sender: email.sender,
      now: () => clock,
      logger: silent,
      workerId,
    });
  const enqueue = createEnqueue({ prisma, config, now: () => clock, logger: silent });
  return { email, worker, tick: () => worker().tick(), enqueue };
}

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const row = (audience: "owner" | "bank", severity: AlertEvent["severity"] = "WARNING") =>
  prisma.alertOutbox.findFirstOrThrow({
    where: { audience, severity },
    orderBy: { id: "desc" },
  });

beforeEach(async () => {
  clock = START;
  for (const mock of Object.values(silent)) mock.mockClear();
  await prisma.$executeRaw`
    TRUNCATE TABLE alert_deliveries, alert_outbox, alert_contacts, alert_businesses
    RESTART IDENTITY CASCADE`;
  await prisma.alertBusiness.create({
    data: { id: "SME-0142", name: "Sri Ganesh Bakery", city: "Chennai", sector: "food" },
  });
  await prisma.alertContact.createMany({
    data: [
      { businessId: "SME-0142", audience: "owner", email: "owner@example.com", consentAt: START },
      { audience: "bank", email: "risk@example.com", consentAt: START },
    ],
  });
});

afterAll(async () => {
  await disconnectDb();
});

describe("alert worker", () => {
  it("emails the owner and the bank, and records both", async () => {
    const { email, enqueue, tick } = setup();
    expect(await enqueue(EVENT)).toBe(true);

    expect(await tick()).toBe(2);

    expect(email.sent).toMatchObject([
      {
        to: "owner@example.com",
        subject: "ClimaCredit alert: Flood risk near Sri Ganesh Bakery, 12–14 Oct",
        html: false,
      },
      {
        to: "risk@example.com",
        subject: "[WARNING] Flood risk — SME-0142 Sri Ganesh Bakery, Chennai — 12–14 Oct",
        html: true,
      },
    ]);

    const owner = await row("owner");
    expect(owner).toMatchObject({
      channel: "email",
      status: "sent",
      attempts: 1,
      claimedBy: null,
      leaseUntil: null,
    });
    expect(await prisma.alertDelivery.findMany({ orderBy: { id: "asc" } })).toMatchObject([
      { outboxId: owner.id, provider: "smtp", providerRef: "smtp-1", result: "sent" },
      { provider: "smtp", providerRef: "smtp-2", result: "sent" },
    ]);
    // Nothing is left to do
    expect(await tick()).toBe(0);
  });

  it("sends an event once however often it is enqueued", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await enqueue(EVENT);
    await tick();
    await enqueue(EVENT);
    await tick();

    expect(await prisma.alertOutbox.count()).toBe(2);
    expect(email.sent).toHaveLength(2);
  });

  it("writes to the owner in their language", async () => {
    await prisma.alertContact.updateMany({ where: { audience: "owner" }, data: { language: "hi" } });
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await tick();

    expect(email.sent[0]?.subject).toContain("बाढ़ का खतरा");
    // The bank's email stays in English
    expect(email.sent[1]?.subject).toContain("Flood risk");
  });

  it("suppresses a repeat at the same severity inside the cooldown", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await tick();

    // The forecast window moved by a day, so this is a new dedupe key
    advance(HOUR_MS);
    await enqueue({ ...EVENT, windowStart: "2026-10-13" });
    await tick();

    expect(email.sent).toHaveLength(2);
    expect(await row("owner")).toMatchObject({ status: "suppressed", attempts: 0 });
    expect((await row("owner")).lastError).toContain("Cooldown");
    expect(await row("bank")).toMatchObject({ status: "suppressed" });

    // Once the 6 hours have passed it goes out again
    advance(6 * HOUR_MS);
    await enqueue({ ...EVENT, windowStart: "2026-10-14" });
    await tick();
    expect(email.sent).toHaveLength(4);
  });

  it("lets a severity upgrade through the cooldown, but not a downgrade", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await tick();

    advance(HOUR_MS);
    await enqueue({ ...EVENT, severity: "CRITICAL" });
    await tick();
    expect(email.sent).toHaveLength(4);

    advance(HOUR_MS);
    await enqueue({ ...EVENT, severity: "WATCH" });
    await tick();
    expect(email.sent).toHaveLength(4);
    expect(await row("owner", "WATCH")).toMatchObject({ status: "suppressed" });
  });

  it("sends at night too: email has no quiet hours", async () => {
    const { email, enqueue, tick } = setup();
    clock = new Date("2026-10-09T23:00:00+05:30");
    await enqueue({ ...EVENT, severity: "WATCH" });
    await tick();

    expect(email.sent.map((message) => message.to)).toEqual(["owner@example.com"]);
  });

  it("never sends without consent, or after an opt-out", async () => {
    const { email, enqueue, tick } = setup();
    await prisma.alertContact.updateMany({ where: { audience: "owner" }, data: { consentAt: null } });
    await prisma.alertContact.updateMany({
      where: { audience: "bank" },
      data: { optedOutAt: START },
    });
    await enqueue(EVENT);
    await tick();

    expect(email.sent).toHaveLength(0);
    const statuses = (await prisma.alertOutbox.findMany()).map((r) => r.status);
    expect(statuses).toEqual(["suppressed", "suppressed"]);
    expect(await prisma.alertDelivery.count()).toBe(0);
  });

  it("suppresses an alert for an owner with no email address", async () => {
    await prisma.alertContact.updateMany({
      where: { audience: "owner" },
      data: { email: null, phoneE164: "+919876543210" },
    });
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await tick();

    expect(email.sent.map((message) => message.to)).toEqual(["risk@example.com"]);
    expect(await row("owner")).toMatchObject({
      status: "suppressed",
      lastError: "No contact with consent and an email address",
    });
  });

  it("suppresses an alert for a business it does not know", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue({ ...EVENT, businessId: "SME-9999" });
    await tick();

    expect(email.sent).toHaveLength(0);
    expect(await row("bank")).toMatchObject({ status: "suppressed", lastError: "Unknown business" });
  });

  it("suppresses an SMS row left in the table, since nothing sends SMS", async () => {
    const { email, tick } = setup();
    await prisma.alertOutbox.create({
      data: {
        dedupeKey: "SME-0142:flood:WARNING:2026-10-12",
        businessId: "SME-0142",
        audience: "owner",
        channel: "sms",
        hazard: "flood",
        severity: "WARNING",
        payload: EVENT,
        nextTryAt: START,
      },
    });
    await tick();

    expect(email.sent).toHaveLength(0);
    expect(await row("owner")).toMatchObject({ status: "suppressed", attempts: 0 });
    expect((await row("owner")).lastError).toContain("SMS is not supported");
  });

  it("retries with backoff and gives up after 5 attempts", async () => {
    const { email, enqueue, tick } = setup();
    email.fail(true);
    await enqueue(EVENT);

    for (const [attempt, waitMinutes] of [1, 2, 4, 8].entries()) {
      await tick();
      const failed = await row("owner");
      expect(failed).toMatchObject({ status: "pending", attempts: attempt + 1 });
      expect(failed.lastError).toBe("smtp is down");
      expect(failed.nextTryAt).toEqual(new Date(clock.getTime() + waitMinutes * MINUTE_MS));

      // Not retried before the backoff is over
      advance(waitMinutes * MINUTE_MS - 1);
      expect(await tick()).toBe(0);
      advance(1);
    }

    await tick();
    expect(await row("owner")).toMatchObject({ status: "dead", attempts: 5 });
    expect(await row("bank")).toMatchObject({ status: "dead", attempts: 5 });
    expect(await prisma.alertDelivery.count({ where: { result: "failed" } })).toBe(10);

    // Dead rows are left alone
    advance(HOUR_MS);
    expect(await tick()).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(silent.error).not.toHaveBeenCalled();
  });

  it("recovers when the provider comes back", async () => {
    const { email, enqueue, tick } = setup();
    email.fail(true);
    await enqueue(EVENT);
    await tick();

    email.fail(false);
    advance(MINUTE_MS);
    await tick();

    expect(email.sent).toHaveLength(2);
    expect(await row("owner")).toMatchObject({ status: "sent", attempts: 2, lastError: null });
  });

  it("records a send that never returns as a failure", async () => {
    const { enqueue } = setup();
    const stuck = createAlertWorker({
      prisma,
      config: loadAlertsConfig({}),
      content,
      sender: { provider: "smtp", send: () => new Promise(() => undefined) },
      sendTimeoutMs: 20,
      now: () => clock,
      logger: silent,
    });
    await enqueue(EVENT);

    await stuck.tick();

    expect(await row("owner")).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "smtp send timed out after 20 ms",
    });
    expect(await row("bank")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("picks up a row whose worker died mid-send, once its lease has expired", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await prisma.alertOutbox.updateMany({
      where: { audience: "owner" },
      data: {
        status: "sending",
        claimedBy: "worker-that-died",
        leaseUntil: new Date(START.getTime() + 2 * MINUTE_MS),
      },
    });

    // Still leased: only the bank's row is taken
    expect(await tick()).toBe(1);
    expect(email.sent.map((message) => message.to)).toEqual(["risk@example.com"]);

    advance(2 * MINUTE_MS);
    expect(await tick()).toBe(1);
    expect(email.sent[1]?.to).toBe("owner@example.com");
    expect(await tick()).toBe(0);
  });

  it("sends each alert once when two workers run at the same time", async () => {
    const { email, enqueue, worker } = setup();
    for (const day of ["12", "13", "14", "15", "16"]) {
      await enqueue({ ...EVENT, hazard: "storm", windowStart: `2026-10-${day}`, severity: "CRITICAL" });
    }
    await enqueue({ ...EVENT, hazard: "heat" });
    await enqueue({ ...EVENT, hazard: "cold_wave" });

    const claimed = await Promise.all([worker("worker-a").tick(), worker("worker-b").tick()]);

    expect((claimed[0] ?? 0) + (claimed[1] ?? 0)).toBe(14);
    const sent = await prisma.alertDelivery.groupBy({ by: ["outboxId"], _count: true });
    expect(sent.every((delivery) => delivery._count === 1)).toBe(true);
    expect(email.sent.length).toBe(sent.length);
    expect(await prisma.alertOutbox.count({ where: { status: { in: ["pending", "sending"] } } })).toBe(0);
  });

  it("batches the bank's WATCH alerts into one daily digest", async () => {
    await prisma.alertBusiness.create({
      data: { id: "SME-0200", name: "Lakshmi Textiles", city: "Surat", sector: "textile" },
    });
    const { email, enqueue, tick } = setup();
    await enqueue({ ...EVENT, severity: "WATCH" });
    await enqueue({ ...EVENT, severity: "WATCH", businessId: "SME-0200", hazard: "heat" });

    // 11:30 IST: the one owner with a contact is told now, the bank is not
    await tick();
    expect(email.sent.map((message) => message.to)).toEqual(["owner@example.com"]);
    expect(await row("bank", "WATCH")).toMatchObject({
      status: "pending",
      nextTryAt: new Date("2026-10-10T09:00:00+05:30"),
    });

    clock = new Date("2026-10-10T09:00:00+05:30");
    await tick();

    expect(email.sent).toHaveLength(2);
    expect(email.sent[1]).toMatchObject({
      to: "risk@example.com",
      subject: "[WATCH] Daily digest — 2 alerts on watch — 10 Oct 2026",
    });
    expect(email.sent[1]?.body).toContain("SME-0142 Sri Ganesh Bakery, Chennai");
    expect(email.sent[1]?.body).toContain("SME-0200 Lakshmi Textiles, Surat");
    expect(await prisma.alertOutbox.count({ where: { audience: "bank", status: "sent" } })).toBe(2);
  });

  it("idles when alerts are switched off", async () => {
    const on = setup();
    await on.enqueue(EVENT);

    const off = setup(loadAlertsConfig({ ALERTS_ENABLED: "false" }));
    expect(await off.enqueue({ ...EVENT, hazard: "heat" })).toBe(false);
    expect(await off.tick()).toBe(0);

    expect(off.email.sent).toHaveLength(0);
    expect(await prisma.alertOutbox.count({ where: { status: "pending" } })).toBe(2);
  });

  it("keeps going when one stored alert is not a valid event", async () => {
    const { email, enqueue, tick } = setup();
    await enqueue(EVENT);
    await prisma.alertOutbox.updateMany({
      where: { audience: "owner" },
      data: { payload: { not: "an event" } },
    });
    await tick();

    expect(await row("owner")).toMatchObject({ status: "dead" });
    expect(email.sent.map((message) => message.to)).toEqual(["risk@example.com"]);
  });

  it("stops after the current message and hands back what it has not sent", async () => {
    const { email, enqueue } = setup();
    const worker = createAlertWorker({
      prisma,
      config: loadAlertsConfig({ ALERTS_POLL_SECONDS: "3600" }),
      content,
      // Asked to stop while the first message is on its way
      sender: {
        provider: "smtp",
        send: (message) => {
          worker.stop();
          return email.sender.send(message);
        },
      },
      now: () => clock,
      logger: silent,
    });
    await enqueue(EVENT);

    await worker.run();

    expect(email.sent).toHaveLength(1);
    expect(await row("owner")).toMatchObject({ status: "sent" });
    expect(await row("bank")).toMatchObject({
      status: "pending",
      attempts: 0,
      claimedBy: null,
      leaseUntil: null,
    });
  });
});

describe("alert reader", () => {
  it("lists alerts newest first with the messages as they were sent", async () => {
    const { enqueue, tick } = setup();
    await enqueue(EVENT);
    await tick();

    const { alerts } = await createAlertReader(prisma).list({ limit: 10 });

    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toMatchObject({
      business_id: "SME-0142",
      business_name: "Sri Ganesh Bakery",
      audience: "owner",
      channel: "email",
      hazard: "flood",
      severity: "WARNING",
      status: "sent",
      attempts: 1,
      window_start: "2026-10-12",
      window_end: "2026-10-14",
      note: null,
      created_at: "2026-10-09T11:30:00+05:30",
      deliveries: [
        {
          provider: "smtp",
          result: "sent",
          subject: "ClimaCredit alert: Flood risk near Sri Ganesh Bakery, 12–14 Oct",
          sent_at: "2026-10-09T11:30:00+05:30",
        },
      ],
    });
    expect(alerts[1]?.deliveries[0]?.body).toContain("A Flood risk is forecast near Sri Ganesh Bakery");
    // Who it went to is never exposed
    expect(JSON.stringify(alerts)).not.toContain("example.com");
  });

  it("filters by business and status", async () => {
    const { enqueue, tick } = setup();
    await enqueue(EVENT);
    await enqueue({ ...EVENT, businessId: "SME-9999" });
    await tick();
    const reader = createAlertReader(prisma);

    expect((await reader.list({ limit: 10, businessId: "SME-9999" })).alerts).toHaveLength(2);
    expect((await reader.list({ limit: 10, status: "sent" })).alerts).toHaveLength(2);
    expect((await reader.list({ limit: 1 })).alerts).toHaveLength(1);
  });
});
