import { pathToFileURL } from "node:url";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createChainVerifier, loadAuditKey, type ChainBreak } from "./chain.js";

const BATCH = 1000;

export interface ChainReport {
  // Hashed events found consistent before the first break, or in all
  checked: number;
  firstBreak: ChainBreak | null;
}

// Walks audit_events in id order and checks every link and hash. Read only.
export async function verifyAuditTrail(prisma: PrismaClient, key: string | null): Promise<ChainReport> {
  const verifier = createChainVerifier(key);
  let after = 0;
  for (;;) {
    const rows = await prisma.auditEvent.findMany({ where: { id: { gt: after } }, orderBy: { id: "asc" }, take: BATCH });
    if (rows.length === 0) return { checked: verifier.checked, firstBreak: null };
    const broken = verifier.check(rows);
    if (broken) return { checked: verifier.checked, firstBreak: broken };
    after = rows[rows.length - 1]?.id ?? after;
  }
}

// npm run audit:verify. Exits 1 when the chain is broken.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { prisma, disconnectDb } = await import("../../config/db.js");
  const key = loadAuditKey();
  if (!key) console.warn("AUDIT_HMAC_KEY is not set: checking plain SHA-256 links, which a full rewrite could forge");
  const report = await verifyAuditTrail(prisma, key);
  await disconnectDb();
  if (report.firstBreak) {
    console.error(
      `Audit trail BROKEN at event ${String(report.firstBreak.id)} (${report.firstBreak.reason}); ${String(report.checked)} events before it are intact`,
    );
    process.exit(1);
  }
  console.log(`Audit trail intact: ${String(report.checked)} chained events checked`);
}
