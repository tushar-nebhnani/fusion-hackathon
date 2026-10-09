import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../../app.js";
import { createTestAdvisor } from "../testing/fixtures.js";

// Loose views of the response bodies this file reads
interface ChatBody {
  conversationId: string;
  structured: { questions: string[]; verdict: string | null };
  proposal: { id: string; options: unknown[] };
}
interface ErrorBody {
  error: { code: string; details: unknown };
}
const body = <T>(res: request.Response) => res.body as T;

function app(devRoutes = true) {
  const { advisor } = createTestAdvisor();
  return createApp({
    climate: {
      getProfile: () => Promise.reject(new Error("not used")),
      getCell: () => Promise.reject(new Error("not used")),
    },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    advisor: { service: advisor, devRoutes },
  });
}

describe("/advisor routes", () => {
  it("runs the README §13 demo script end to end over HTTP", async () => {
    const server = app();

    // 1. A kirana store asks about a ₹3L loan: two questions, then a verdict
    const ask = await request(server)
      .post("/advisor/chat")
      .send({ businessId: "SME-0101", loanId: "LN-0101", message: "Should I take a ₹3L loan?" });
    expect(ask.status).toBe(200);
    expect(body<ChatBody>(ask).structured.questions).toHaveLength(2);
    const verdict = await request(server).post("/advisor/chat").send({
      businessId: "SME-0101",
      conversationId: body<ChatBody>(ask).conversationId,
      message: "Dry goods mostly. Kept on the ground floor.",
    });
    expect(body<ChatBody>(verdict).structured.verdict).toBe("viable_with_conditions");

    // 2. The bank disburses; a heavy-rain warning fires
    const disbursed = await request(server).post("/advisor/loans/LN-0101/disburse").send({});
    expect(body<{ state: string }>(disbursed).state).toBe("ACTIVE");
    const alert = await request(server).post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    expect(alert.status).toBe(200);
    expect(body<{ results: { smsText: string }[] }>(alert).results[0]?.smsText.length).toBeLessThanOrEqual(160);
    const state = await request(server).get("/advisor/loans/LN-0101/state");
    expect(body<{ state: string }>(state).state).toBe("ALERT");

    // 3. Damage report: closed 6 days, ₹40k stock lost; the bank accepts
    const damage = await request(server).post("/advisor/damage-report").send({
      loanId: "LN-0101",
      daysClosed: 6,
      stockLossInr: 40_000,
      equipmentDamageInr: 0,
      expectedReopenDate: "2026-10-09",
      insuranceClaim: { status: "none" },
    });
    expect(damage.status).toBe(200);
    const { proposal } = body<ChatBody>(damage);
    expect(proposal.options).toHaveLength(3);
    const decision = await request(server)
      .post(`/advisor/proposals/${proposal.id}/decision`)
      .send({ decision: "accept", note: "approved by branch" });
    expect(body<{ loanState: { state: string } }>(decision).loanState.state).toBe("RECOVERY");

    const history = await request(server).get("/advisor/conversations/SME-0101");
    const { conversations } = body<{ conversations: { messages: { citations: string[] }[] }[] }>(history);
    expect(conversations).toHaveLength(3);
    expect(conversations[2]?.messages.at(-1)?.citations.length).toBeGreaterThan(0);
  });

  it("validates input with the standard error shape", async () => {
    const res = await request(app()).post("/advisor/chat").send({ businessId: "SME-0101" });
    expect(res.status).toBe(400);
    expect(body<ErrorBody>(res).error.code).toBe("BAD_REQUEST");
  });

  it("answers an unknown business with 404", async () => {
    const res = await request(app()).post("/advisor/chat").send({ businessId: "SME-9999", message: "hi" });
    expect(res.status).toBe(404);
  });

  it("refuses an invalid state change with 409", async () => {
    const res = await request(app()).post("/advisor/loans/LN-0142/disburse").send({});
    expect(res.status).toBe(409);
    expect(body<ErrorBody>(res).error.details).toMatchObject({ state: "ACTIVE", event: "disbursed" });
  });

  it("does not mount dev routes when they are off", async () => {
    const res = await request(app(false)).post("/advisor/dev/fake-alert").send({});
    expect(res.status).toBe(404);
  });
});
