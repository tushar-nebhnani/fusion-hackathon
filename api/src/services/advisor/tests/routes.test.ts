import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../../app.js";
import type { AdvisorAccess } from "../../../controllers/advisor.controller.js";
import { NotFoundError } from "../../../errors/app-error.js";
import { BANK, OWNER, fakeAuth, signedIn } from "../../auth/testing/fake-auth.js";
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

// Every business is open unless a test passes its own access rule
const open: AdvisorAccess = () => Promise.resolve();

function app(devRoutes = true, assertAccess = open, advisorAnswerRateLimit?: number) {
  const { advisor } = createTestAdvisor();
  return createApp({
    auth: { service: fakeAuth() },
    climate: {
      getProfile: () => Promise.reject(new Error("not used")),
      getCell: () => Promise.reject(new Error("not used")),
    },
    checkDb: () => Promise.resolve(),
    upstreamStatus: () => ({ state: "unknown", checked_at: null }),
    advisor: { service: advisor, devRoutes, assertAccess },
    advisorAnswerRateLimit,
  });
}

describe("/advisor routes", () => {
  it("runs the README §13 demo script end to end over HTTP", async () => {
    const server = app();
    const owner = () => signedIn(server, OWNER);
    const bank = () => signedIn(server, BANK);

    // 1. A kirana store asks about a ₹3L loan: two questions, then a verdict
    const ask = await owner()
      .post("/advisor/chat")
      .send({ businessId: "SME-0101", loanId: "LN-0101", message: "Should I take a ₹3L loan?" });
    expect(ask.status).toBe(200);
    expect(body<ChatBody>(ask).structured.questions).toHaveLength(2);
    const verdict = await owner().post("/advisor/chat").send({
      businessId: "SME-0101",
      conversationId: body<ChatBody>(ask).conversationId,
      message: "Dry goods mostly. Kept on the ground floor.",
    });
    expect(body<ChatBody>(verdict).structured.verdict).toBe("viable_with_conditions");

    // 2. The bank disburses; a heavy-rain warning fires
    const disbursed = await bank().post("/advisor/loans/LN-0101/disburse").send({});
    expect(body<{ state: string }>(disbursed).state).toBe("ACTIVE");
    const alert = await bank().post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    expect(alert.status).toBe(200);
    expect(body<{ results: { smsText: string }[] }>(alert).results[0]?.smsText.length).toBeLessThanOrEqual(160);
    const state = await owner().get("/advisor/loans/LN-0101/state");
    expect(body<{ state: string }>(state).state).toBe("ALERT");

    // 3. Damage report: closed 6 days, ₹40k stock lost; the bank accepts
    const damage = await owner().post("/advisor/damage-report").send({
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
    // An owner cannot decide; only the bank can
    const byOwner = await owner().post(`/advisor/proposals/${proposal.id}/decision`).send({ decision: "accept" });
    expect(byOwner.status).toBe(403);
    const decision = await bank()
      .post(`/advisor/proposals/${proposal.id}/decision`)
      .send({ decision: "accept", note: "approved by branch" });
    const decided = body<{ loanState: { state: string }; proposal: { decidedBy: string } }>(decision);
    expect(decided.loanState.state).toBe("RECOVERY");
    expect(decided.proposal.decidedBy).toBe(BANK.email);

    const history = await owner().get("/advisor/conversations/SME-0101");
    const { conversations } = body<{ conversations: { messages: { citations: string[] }[] }[] }>(history);
    expect(conversations).toHaveLength(3);
    expect(conversations[2]?.messages.at(-1)?.citations.length).toBeGreaterThan(0);
  });

  it("needs a signed-in user", async () => {
    const res = await request(app()).post("/advisor/chat").send({ businessId: "SME-0101", message: "hi" });
    expect(res.status).toBe(401);
  });

  it("validates input with the standard error shape", async () => {
    const res = await signedIn(app()).post("/advisor/chat").send({ businessId: "SME-0101" });
    expect(res.status).toBe(400);
    expect(body<ErrorBody>(res).error.code).toBe("BAD_REQUEST");
  });

  it("allows five answers a minute for each user by default", async () => {
    const server = app();
    const chat = (user = OWNER) =>
      signedIn(server, user).post("/advisor/chat").send({ businessId: "SME-9999", message: "hi" });

    for (let i = 0; i < 5; i += 1) expect((await chat()).status).toBe(404);
    const limited = await chat();
    expect(limited.status).toBe(429);
    expect(body<ErrorBody>(limited).error.code).toBe("RATE_LIMITED");

    // Another user has their own count, and reading is not an answer
    expect((await chat(BANK)).status).toBe(404);
    expect((await signedIn(server).get("/advisor/businesses")).status).toBe(200);
  });

  it("counts chat and damage reports as one limit", async () => {
    const server = app(true, open, 2);
    const chat = () => signedIn(server).post("/advisor/chat").send({ businessId: "SME-9999", message: "hi" });
    const damage = () => signedIn(server).post("/advisor/damage-report").send({ loanId: "LN-9999", daysClosed: 2 });

    expect((await chat()).status).toBe(404);
    expect((await damage()).status).toBe(404);
    expect((await chat()).status).toBe(429);
    expect((await damage()).status).toBe(429);
  });

  it("answers an unknown business with 404", async () => {
    const res = await signedIn(app()).post("/advisor/chat").send({ businessId: "SME-9999", message: "hi" });
    expect(res.status).toBe(404);
  });

  it("refuses an invalid state change with 409", async () => {
    const res = await signedIn(app(), BANK).post("/advisor/loans/LN-0142/disburse").send({});
    expect(res.status).toBe(409);
    expect(body<ErrorBody>(res).error.details).toMatchObject({ state: "ACTIVE", event: "disbursed" });
  });

  it("hides a business the user may not see, on every route that names it", async () => {
    // Only SME-0101 is this user's
    const mine: AdvisorAccess = (businessId) =>
      businessId === "SME-0101" ? Promise.resolve() : Promise.reject(new NotFoundError("Business not found"));
    const server = app(true, mine);

    const chat = await signedIn(server).post("/advisor/chat").send({ businessId: "SME-0142", message: "hi" });
    const state = await signedIn(server).get("/advisor/loans/LN-0142/state");
    const history = await signedIn(server).get("/advisor/conversations/SME-0142");
    const damage = await signedIn(server)
      .post("/advisor/damage-report")
      .send({ loanId: "LN-0142", daysClosed: 2 });
    const disburse = await signedIn(server, BANK).post("/advisor/loans/LN-0142/disburse").send({});
    expect([chat, state, history, damage, disburse].map((res) => res.status)).toEqual([404, 404, 404, 404, 404]);

    const list = await signedIn(server).get("/advisor/businesses");
    expect(body<{ businesses: { id: string }[] }>(list).businesses.map((b) => b.id)).toEqual(["SME-0101"]);
    expect((await signedIn(server).get("/advisor/loans/LN-0101/state")).status).toBe(200);
  });

  it("lists the businesses as JSON, not an unresolved promise", async () => {
    const res = await signedIn(app()).get("/advisor/businesses");
    expect(body<{ businesses: unknown[] }>(res).businesses.length).toBeGreaterThan(0);
  });

  it("keeps the dev routes for bank officers: an owner cannot fire alerts", async () => {
    const server = app();
    for (const path of ["fake-alert", "verify-alert", "sweep-alerts"]) {
      const owner = await signedIn(server, OWNER).post(`/advisor/dev/${path}`).send({ loanIds: ["LN-0101"] });
      expect(owner.status, path).toBe(403);
      const anonymous = await request(server).post(`/advisor/dev/${path}`).send({});
      expect(anonymous.status, path).toBe(401);
    }
    const bank = await signedIn(server, BANK).post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    expect(bank.status).toBe(200);
  });

  it("lets a bank officer act only on businesses the bank may see", async () => {
    // The bank loses sight of SME-0101 (its owner withdrew consent, say) after the owner has used the advisor
    let hidden = false;
    const access: AdvisorAccess = (businessId, actor) =>
      hidden && actor.role === "bank" && businessId === "SME-0101"
        ? Promise.reject(new NotFoundError(`Business ${businessId} not found`))
        : Promise.resolve();
    const server = app(true, access);
    const owner = () => signedIn(server, OWNER);
    const bank = () => signedIn(server, BANK);

    const ask = await owner().post("/advisor/chat").send({ businessId: "SME-0101", loanId: "LN-0101", message: "Should I take a ₹3L loan?" });
    await owner().post("/advisor/chat").send({
      businessId: "SME-0101",
      conversationId: body<ChatBody>(ask).conversationId,
      message: "Dry goods mostly. Kept on the ground floor.",
    });
    await bank().post("/advisor/loans/LN-0101/disburse").send({});
    await bank().post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    const damage = await owner().post("/advisor/damage-report").send({
      loanId: "LN-0101",
      daysClosed: 6,
      stockLossInr: 40_000,
      equipmentDamageInr: 0,
      expectedReopenDate: "2026-10-09",
      insuranceClaim: { status: "none" },
    });
    const { proposal } = body<ChatBody>(damage);

    hidden = true;
    const decide = await bank().post(`/advisor/proposals/${proposal.id}/decision`).send({ decision: "accept" });
    expect(decide.status).toBe(404);
    const fake = await bank().post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    expect(fake.status).toBe(404);
    // The refusal changed nothing: once the bank may see the business again it can decide
    hidden = false;
    const later = await bank().post(`/advisor/proposals/${proposal.id}/decision`).send({ decision: "accept" });
    expect(later.status).toBe(200);
  });

  it("lets the bank decide only proposals of businesses it may see", async () => {
    let hidden = false;
    const access: AdvisorAccess = () =>
      hidden ? Promise.reject(new NotFoundError("Business not found")) : Promise.resolve();
    const server = app(true, access);
    const bank = () => signedIn(server, BANK);
    await bank().post("/advisor/loans/LN-0101/disburse").send({});
    await bank().post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0101"] });
    const damage = await signedIn(server).post("/advisor/damage-report").send({
      loanId: "LN-0101",
      daysClosed: 6,
      stockLossInr: 40_000,
      equipmentDamageInr: 0,
      expectedReopenDate: "2026-10-09",
      insuranceClaim: { status: "none" },
    });
    const { proposal } = body<ChatBody>(damage);

    hidden = true;
    const decision = await bank().post(`/advisor/proposals/${proposal.id}/decision`).send({ decision: "accept" });
    expect(decision.status).toBe(404);
    hidden = false;
    expect((await bank().get("/advisor/loans/LN-0101/state")).body).toMatchObject({ state: "IMPACTED" });
  });

  it("keeps the dev routes to bank officers", async () => {
    const server = app();
    const owner = () => signedIn(server);
    const statuses = [
      await owner().post("/advisor/dev/fake-alert").send({ loanIds: ["LN-0142"] }),
      await owner().post("/advisor/dev/verify-alert").send({ alertId: "fake-1", label: "hit" }),
      await owner().post("/advisor/dev/sweep-alerts").send({}),
    ].map((res) => res.status);
    expect(statuses).toEqual([403, 403, 403]);
    // Nothing moved: LN-0142 starts ACTIVE in smes.json
    expect((await signedIn(server, BANK).get("/advisor/loans/LN-0142/state")).body).toMatchObject({ state: "ACTIVE" });
  });

  it("does not mount dev routes when they are off", async () => {
    const res = await signedIn(app(false)).post("/advisor/dev/fake-alert").send({});
    expect(res.status).toBe(404);
  });
});
