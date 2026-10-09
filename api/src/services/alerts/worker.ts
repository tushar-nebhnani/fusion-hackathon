import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AlertOutbox, Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { findAlertBusiness, inputOwnerRecipient } from "./businesses.js";
import { loadAlertsConfig, type AlertsConfig } from "./config.js";
import { MAX_ATTEMPTS, backoffMs, inCooldown, isDigest } from "./policy.js";
import {
  loadContent,
  renderAlert,
  renderDigest,
  type AlertBusinessInfo,
  type Content,
  type RenderedMessage,
} from "./render.js";
import { createDryRunSender } from "./senders/dryRun.js";
import type { Sender } from "./senders/Sender.js";
import { LANGUAGES, alertEventSchema, type AlertEvent, type Language } from "./types.js";
import { withTimeout } from "./withTimeout.js";

const BATCH_SIZE = 20;
const LEASE_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
// SMTP also has its own 10 s connection and socket timeouts; this bounds the whole send
const SEND_TIMEOUT_MS = 20_000;

export interface WorkerDeps {
  prisma: PrismaClient;
  config: AlertsConfig;
  content: Content;
  sender: Sender;
  // How long one send may take. Defaults to 20 s
  sendTimeoutMs?: number;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn" | "error">;
  workerId?: string;
}

export interface AlertWorker {
  // Claims and handles one batch. Resolves to the number of rows claimed.
  tick(): Promise<number>;
  // Polls until stop() is called
  run(): Promise<void>;
  // Finishes the current message, releases the rest and ends run()
  stop(): void;
}

interface Recipient {
  to: string;
  language: Language;
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

const isLanguage = (value: string): value is Language =>
  (LANGUAGES as readonly string[]).includes(value);

export function createAlertWorker(deps: WorkerDeps): AlertWorker {
  const { prisma, config, content, sender } = deps;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const sendTimeoutMs = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  let stopping = false;
  let wake: () => void = () => undefined;

  // Rows that are due, and rows whose worker died while holding them
  const claimable = (at: Date): Prisma.AlertOutboxWhereInput => ({
    OR: [
      { status: "pending", nextTryAt: { lte: at } },
      { status: "sending", leaseUntil: { lte: at } },
    ],
  });

  async function claim(): Promise<AlertOutbox[]> {
    const at = now();
    const candidates = await prisma.alertOutbox.findMany({
      where: claimable(at),
      orderBy: [{ nextTryAt: "asc" }, { id: "asc" }],
      take: BATCH_SIZE,
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    const ids = candidates.map((row) => row.id);

    // The UPDATE checks the condition again, so of two workers that saw the
    // same row only one claims it
    await prisma.alertOutbox.updateMany({
      where: { id: { in: ids }, ...claimable(at) },
      data: { status: "sending", claimedBy: workerId, leaseUntil: new Date(at.getTime() + LEASE_MS) },
    });
    return prisma.alertOutbox.findMany({
      where: { id: { in: ids }, status: "sending", claimedBy: workerId },
      orderBy: { id: "asc" },
    });
  }

  // Extends the lease just before sending. False means the lease ran out and
  // another worker now holds the row, so this one must not send it.
  async function stillMine(row: AlertOutbox): Promise<boolean> {
    const { count } = await prisma.alertOutbox.updateMany({
      where: { id: row.id, status: "sending", claimedBy: workerId },
      data: { leaseUntil: new Date(now().getTime() + LEASE_MS) },
    });
    return count === 1;
  }

  async function release(): Promise<void> {
    await prisma.alertOutbox.updateMany({
      where: { status: "sending", claimedBy: workerId },
      data: { status: "pending", claimedBy: null, leaseUntil: null },
    });
  }

  const settle = (row: AlertOutbox, data: Prisma.AlertOutboxUpdateInput) =>
    prisma.alertOutbox.update({
      where: { id: row.id },
      data: { ...data, claimedBy: null, leaseUntil: null },
    });

  async function suppress(row: AlertOutbox, reason: string): Promise<void> {
    await settle(row, { status: "suppressed", lastError: reason });
  }

  // Only contacts who agreed and have not opted out
  async function recipient(row: AlertOutbox): Promise<Recipient | null> {
    const consenting = { consentAt: { not: null }, optedOutAt: null };
    if (row.audience === "bank") {
      const contacts = await prisma.alertContact.findMany({
        where: { audience: "bank", email: { not: null }, ...consenting },
        orderBy: { id: "asc" },
      });
      const to = contacts.map((contact) => contact.email).join(", ");
      return to ? { to, language: "en" } : null;
    }
    const contact = await prisma.alertContact.findFirst({
      where: {
        audience: "owner",
        businessId: row.businessId,
        email: { not: null },
        ...consenting,
      },
      orderBy: { id: "asc" },
    });
    if (!contact?.email) return inputOwnerRecipient(prisma, row.businessId);
    return { to: contact.email, language: isLanguage(contact.language) ? contact.language : "en" };
  }

  async function coolingDown(row: AlertOutbox): Promise<boolean> {
    const since = new Date(now().getTime() - config.cooldownHours * HOUR_MS);
    const recent = await prisma.alertOutbox.findMany({
      where: {
        id: { not: row.id },
        businessId: row.businessId,
        hazard: row.hazard,
        audience: row.audience,
        channel: row.channel,
        status: "sent",
        deliveries: { some: { result: "sent", sentAt: { gte: since } } },
      },
      select: { severity: true },
    });
    return inCooldown(
      row.severity,
      recent.map((sent) => sent.severity),
    );
  }

  // The checks that need no recipient. Settles the row and resolves to null
  // when it should not be sent.
  async function prepare(
    row: AlertOutbox,
  ): Promise<{ event: AlertEvent; business: AlertBusinessInfo } | null> {
    const parsed = alertEventSchema.safeParse(row.payload);
    if (!parsed.success) {
      await settle(row, { status: "dead", lastError: "Stored event is not valid" });
      return null;
    }
    const business = await findAlertBusiness(prisma, row.businessId);
    if (!business) {
      await suppress(row, "Unknown business");
      return null;
    }
    if (await coolingDown(row)) {
      await suppress(row, "Cooldown: this hazard was already alerted at this severity or higher");
      return null;
    }
    return { event: parsed.data, business };
  }

  async function recordSent(
    rows: readonly AlertOutbox[],
    provider: string,
    message: RenderedMessage,
    providerRef?: string,
  ): Promise<void> {
    const sentAt = now();
    await prisma.$transaction(
      rows.flatMap((row) => [
        prisma.alertDelivery.create({
          data: {
            outboxId: row.id,
            provider,
            providerRef,
            result: "sent",
            subject: message.subject || null,
            body: message.body,
            sentAt,
          },
        }),
        settle(row, { status: "sent", attempts: row.attempts + 1, lastError: null }),
      ]),
    );
  }

  async function recordFailed(
    rows: readonly AlertOutbox[],
    provider: string,
    message: RenderedMessage | undefined,
    error: string,
  ): Promise<void> {
    const at = now();
    for (const row of rows) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await prisma.$transaction([
        prisma.alertDelivery.create({
          data: {
            outboxId: row.id,
            provider,
            result: "failed",
            error,
            subject: message?.subject || null,
            body: message?.body,
            sentAt: at,
          },
        }),
        settle(row, {
          status: dead ? "dead" : "pending",
          attempts,
          nextTryAt: new Date(at.getTime() + backoffMs(attempts)),
          lastError: error,
        }),
      ]);
      logger.warn(
        `alerts: ${row.channel} to ${row.audience} for ${row.businessId} failed ` +
          `(attempt ${attempts} of ${MAX_ATTEMPTS}${dead ? ", giving up" : ""}): ${error}`,
      );
    }
  }

  // Renders and sends one message that settles one or more rows. A failure
  // is recorded on the rows, never thrown.
  async function deliver(
    rows: readonly AlertOutbox[],
    to: string,
    render: () => RenderedMessage,
  ): Promise<void> {
    let message: RenderedMessage | undefined;
    let providerRef: string | undefined;
    try {
      message = render();
      const result = await withTimeout(
        sender.send({ ...message, to }),
        sendTimeoutMs,
        `${sender.provider} send`,
      );
      providerRef = result.providerRef;
    } catch (error) {
      await recordFailed(rows, sender.provider, message, errorText(error));
      return;
    }
    await recordSent(rows, sender.provider, message, providerRef);
  }

  async function processRow(row: AlertOutbox): Promise<void> {
    // The table still allows SMS rows, but nothing sends them any more
    if (row.channel !== "email") {
      await suppress(row, "SMS is not supported: only email is sent");
      return;
    }
    const ready = await prepare(row);
    if (!ready) return;

    const target = await recipient(row);
    if (!target) {
      await suppress(row, "No contact with consent and an email address");
      return;
    }

    if (!(await stillMine(row))) return;
    await deliver([row], target.to, () =>
      renderAlert(content, {
        audience: row.audience,
        language: target.language,
        event: ready.event,
        business: ready.business,
        dashboardUrl: config.dashboardUrl,
      }),
    );
  }

  async function processDigest(rows: readonly AlertOutbox[]): Promise<void> {
    const alerts: { row: AlertOutbox; event: AlertEvent; business: AlertBusinessInfo }[] = [];
    for (const row of rows) {
      const ready = await prepare(row);
      if (ready) alerts.push({ row, ...ready });
    }
    const first = alerts[0];
    if (!first) return;

    const target = await recipient(first.row);
    const held: typeof alerts = [];
    for (const alert of alerts) {
      if (!target) await suppress(alert.row, "No contact with consent and an email address");
      else if (await stillMine(alert.row)) held.push(alert);
    }
    if (!target || held.length === 0) return;

    const date = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(now());
    await deliver(
      held.map((alert) => alert.row),
      target.to,
      () => renderDigest(content, held, { dashboardUrl: config.dashboardUrl, date }),
    );
  }

  // One bad row must not stop the rest of the batch. A row left in
  // `sending` here is handed back by release() and tried again.
  async function guarded(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.error(`alerts: ${what} failed,`, errorText(error));
    }
  }

  async function tick(): Promise<number> {
    if (!config.enabled) return 0;
    const rows = await claim();
    if (rows.length === 0) return 0;

    for (const row of rows.filter((candidate) => !isDigest(candidate))) {
      if (stopping) break;
      await guarded(`alert ${row.id}`, () => processRow(row));
    }
    const digest = rows.filter((candidate) => isDigest(candidate));
    if (!stopping && digest.length > 0) await guarded("bank digest", () => processDigest(digest));

    await release();
    return rows.length;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // A polling loop with await: a slow batch delays the next poll instead of
  // overlapping it
  async function run(): Promise<void> {
    while (!stopping) {
      await guarded("worker tick", async () => {
        await tick();
      });
      if (!stopping) await sleep(config.pollSeconds * 1000);
    }
    await guarded("releasing leases", release);
  }

  function stop(): void {
    stopping = true;
    wake();
  }

  return { tick, run, stop };
}

async function main(): Promise<void> {
  const { prisma, disconnectDb } = await import("../../config/db.js");
  const config = loadAlertsConfig();

  // nodemailer is loaded only when messages really go out
  const chosen =
    config.mode === "live"
      ? (await import("./senders/emailSmtp.js")).createSmtpSender(config.smtp)
      : createDryRunSender();
  // ALERTS_REDIRECT_TO: consent and cooldown still decide whether a message
  // goes out; only the address it goes to changes
  const redirectTo = config.redirectTo;
  const sender: Sender = redirectTo
    ? { provider: chosen.provider, send: (message) => chosen.send({ ...message, to: redirectTo }) }
    : chosen;
  if (redirectTo) console.warn(`Alert worker: every email is redirected to ${redirectTo}`);

  const worker = createAlertWorker({ prisma, config, content: loadContent(), sender });

  // Log and keep going. This is its own process, so the API is unaffected either way.
  process.on("unhandledRejection", (reason) => {
    console.error("alerts: unhandled rejection,", errorText(reason));
  });
  process.on("uncaughtException", (error) => {
    console.error("alerts: uncaught exception,", errorText(error));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log("Alert worker: stopping after the current message");
      worker.stop();
    });
  }

  console.log(
    `Alert worker: mode ${config.mode}, polling every ${config.pollSeconds} s` +
      (config.enabled ? "" : " (ALERTS_ENABLED=false, idling)"),
  );
  await worker.run();
  await disconnectDb();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
