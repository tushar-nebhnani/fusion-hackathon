import { parseArgs } from "node:util";
import { disconnectDb, prisma } from "../../config/db.js";
import { loadAlertsConfig } from "./config.js";
import { createEnqueue } from "./enqueue.js";
import { alertEventSchema, dedupeKey } from "./types.js";

// Fires a test event by hand, the way the background monitor does on its own:
//   npm run alerts:test -- --business SME-0142 --hazard flood --severity WARNING
// Add --seed to create the demo business and its contacts first.

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDate = (daysAhead: number) =>
  new Date(Date.now() + IST_OFFSET_MS + daysAhead * DAY_MS).toISOString().slice(0, 10);

const { values } = parseArgs({
  options: {
    business: { type: "string", default: "SME-0142" },
    hazard: { type: "string", default: "flood" },
    severity: { type: "string", default: "WARNING" },
    "window-start": { type: "string", default: istDate(3) },
    "window-end": { type: "string", default: istDate(5) },
    evidence: { type: "string", default: "Test event from the alerts CLI" },
    seed: { type: "boolean", default: false },
    "owner-email": { type: "string", default: "owner@example.com" },
    "owner-language": { type: "string", default: "en" },
    "bank-email": { type: "string", default: "risk-team@example.com" },
  },
});

// Demo business with one owner and one bank contact, both with consent.
// Leaves existing rows alone, so real contact details are never overwritten.
async function seed(businessId: string): Promise<void> {
  await prisma.alertBusiness.upsert({
    where: { id: businessId },
    update: {},
    create: { id: businessId, name: "Sri Ganesh Bakery", city: "Chennai", sector: "food" },
  });
  const consentAt = new Date();
  if (!(await prisma.alertContact.findFirst({ where: { audience: "owner", businessId } }))) {
    await prisma.alertContact.create({
      data: {
        businessId,
        audience: "owner",
        name: "Demo owner",
        email: values["owner-email"],
        language: values["owner-language"],
        consentAt,
      },
    });
  }
  if (!(await prisma.alertContact.findFirst({ where: { audience: "bank" } }))) {
    await prisma.alertContact.create({
      data: { audience: "bank", name: "Demo risk team", email: values["bank-email"], consentAt },
    });
  }
  console.log(`Seeded demo business ${businessId} and its contacts (existing rows are kept)`);
}

async function main(): Promise<void> {
  const config = loadAlertsConfig();
  const event = alertEventSchema.safeParse({
    businessId: values.business,
    hazard: values.hazard,
    severity: values.severity.toUpperCase(),
    windowStart: values["window-start"],
    windowEnd: values["window-end"],
    evidence: values.evidence,
    sourceRunId: `cli-${new Date().toISOString().slice(0, 16)}`,
  });
  if (!event.success) {
    const issue = event.error.issues[0];
    console.error(`Invalid event: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`);
    process.exitCode = 1;
    return;
  }

  if (values.seed) await seed(event.data.businessId);

  const queued = await createEnqueue({ prisma, config })(event.data);
  if (!queued) {
    console.error(
      config.enabled ? "Not queued: see the error above" : "Not queued: ALERTS_ENABLED is false",
    );
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.alertOutbox.findMany({
    where: { dedupeKey: dedupeKey(event.data) },
    orderBy: { id: "asc" },
  });
  console.log(`Event ${dedupeKey(event.data)} is in the outbox (mode: ${config.mode}):`);
  for (const row of rows) {
    console.log(`  #${row.id} ${row.audience} ${row.channel}: ${row.status}`);
  }
  console.log("Run `npm run alerts:worker` to send. The same event queued twice is sent once.");
}

try {
  await main();
} finally {
  await disconnectDb();
}
