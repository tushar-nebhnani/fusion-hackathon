import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnectDb, prisma } from "../../config/db.js";
import { createPrismaAuditRecorder, type AuditEvent } from "./recorder.js";

// Integration tests against the real test database
const EVENT: AuditEvent = {
  requestId: "0b9d4d3e-7c58-4e1f-9a53-2f1f2f0c7a11",
  actorId: "user-owner",
  actorRole: "owner",
  action: "PUT /businesses/:id/locations",
  targetType: "business",
  targetId: "b-1",
  outcome: "denied",
  status: 403,
  reason: "LOCKED_BY_LOAN",
};

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE TABLE audit_events RESTART IDENTITY`;
});

afterAll(async () => {
  await disconnectDb();
});

describe("prisma audit recorder", () => {
  it("stores the event with the time it was recorded", async () => {
    const recorder = createPrismaAuditRecorder(prisma);
    const before = Date.now();

    recorder.record(EVENT);
    await recorder.idle();

    const rows = await prisma.auditEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(EVENT);
    expect(rows[0]?.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("cuts over-long values instead of losing the event", async () => {
    const recorder = createPrismaAuditRecorder(prisma);

    recorder.record({ ...EVENT, targetId: "x".repeat(5000), action: `GET /${"y".repeat(5000)}` });
    await recorder.idle();

    const row = await prisma.auditEvent.findFirstOrThrow();
    expect(row.targetId).toHaveLength(128);
    expect(row.action).toHaveLength(200);
  });

  it("is append only: the database refuses to change or remove an event", async () => {
    const recorder = createPrismaAuditRecorder(prisma);
    recorder.record(EVENT);
    await recorder.idle();

    await expect(prisma.auditEvent.updateMany({ data: { outcome: "success" } })).rejects.toThrow();
    await expect(prisma.auditEvent.deleteMany()).rejects.toThrow();

    expect(await prisma.auditEvent.findMany()).toMatchObject([{ outcome: "denied" }]);
  });

  it("reports a write that failed without throwing or printing the event", async () => {
    const logger = { error: vi.fn() };
    const broken = {
      auditEvent: { create: () => Promise.reject(new Error("connection refused for user-owner")) },
    } as unknown as typeof prisma;
    const recorder = createPrismaAuditRecorder(broken, logger);

    recorder.record(EVENT);
    await recorder.idle();

    expect(logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("user-owner");
  });
});
