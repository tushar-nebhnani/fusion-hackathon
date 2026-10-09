import { describe, expect, it } from "vitest";
import { ConflictError } from "../../../errors/app-error.js";
import { buildFakeAlert } from "../dev/fakeAlert.js";
import type { LlmClient, LlmReply } from "../llm/client.js";
import { createTestAdvisor } from "../testing/fixtures.js";

// Every citation points at a logged tool call, and no answer carries a number
// the checks could not trace (README §12: every number traces to tool_calls)
function expectTraceable(
  result: { citations: string[]; warnings: string[] },
  toolCalls: { callId: string; error: string | null }[],
) {
  const logged = new Set(toolCalls.filter((c) => !c.error).map((c) => c.callId));
  for (const citation of result.citations) expect(logged).toContain(citation.split(".")[0]);
  expect(result.warnings).toEqual([]);
}

describe("Mode 1: pre-loan advisor", () => {
  it("asks at most two questions, saves the answers, then gives a verdict", async () => {
    const { advisor, repo } = createTestAdvisor();
    const first = await advisor.handleChat({ businessId: "SME-0101", message: "Should I take a ₹3L loan?" });

    expect(first.mode).toBe("preLoan");
    expect(first.structured?.questions).toHaveLength(2);
    expect(first.structured?.verdict).toBeNull();

    const second = await advisor.handleChat({
      businessId: "SME-0101",
      conversationId: first.conversationId,
      message: "Mostly dry goods like rice and dal. The stock is kept on the ground floor.",
    });
    expect(second.structured?.verdict).toBe("viable_with_conditions");
    const suggestions = second.structured?.loanStructureSuggestions as string[];
    expect(suggestions.some((s) => s.includes("EMI holiday"))).toBe(true);
    expect(suggestions.some((s) => s.includes("Raise stock storage"))).toBe(true);
    expect(second.toolCalls.some((c) => c.tool === "simulateScenario")).toBe(true);

    const facts = await repo.getFacts("SME-0101");
    expect(facts.map((f) => [f.key, f.source])).toEqual(
      expect.arrayContaining([
        ["stock_perishable", "owner_chat"],
        ["storage_level", "owner_chat"],
      ]),
    );
    expectTraceable(second, await repo.listToolCalls(first.conversationId));
  });

  it("gives different verdicts for different businesses", async () => {
    const { advisor, repo } = createTestAdvisor();
    // The tailor's onboarding form already answers every risk question
    const tailor = await advisor.handleChat({ businessId: "SME-0307", message: "Can I take a ₹2L loan?" });
    expect(tailor.structured?.verdict).toBe("viable");
    expectTraceable(tailor, await repo.listToolCalls(tailor.conversationId));

    const agro = await advisor.handleChat({ businessId: "SME-0203", message: "I need ₹4L for stock." });
    expect(agro.structured?.questions).toHaveLength(2);
    const agroVerdict = await advisor.handleChat({
      businessId: "SME-0203",
      conversationId: agro.conversationId,
      message: "Seed and fertiliser bags, not perishable. Kept on raised platforms.",
    });
    expect(agroVerdict.structured?.verdict).toBe("high_risk");
    // No weather-impact rating for this business: the answer must say so
    expect(agroVerdict.reply).toContain("has not been rated");
    expectTraceable(agroVerdict, await repo.listToolCalls(agro.conversationId));
  });

  it("says climate data is unavailable instead of guessing", async () => {
    const { advisor } = createTestAdvisor({ climateDown: true });
    const result = await advisor.handleChat({ businessId: "SME-0307", message: "Can I take a ₹2L loan?" });
    expect(result.reply).toContain("unavailable");
    expect(result.structured?.verdict).toBeNull();
    // The evaluation itself answers; its climate check says why there is no verdict
    expect(result.toolCalls.find((c) => c.tool === "getEvaluation")?.ok).toBe(true);
  });
});

describe("Mode 2: alert advisor", () => {
  it("advises, messages the owner and bank, and returns to ACTIVE after the window", async () => {
    let now = new Date("2026-10-09T06:00:00Z");
    const { advisor, sent, repo } = createTestAdvisor({ now: () => now });
    const event = buildFakeAlert(
      { loanIds: ["LN-0142"], hazard: "heavy_rain", startsInHours: 18, durationHours: 24 },
      now,
    );

    const outcome = await advisor.handleAlert(event);
    const result = outcome.results[0] as {
      actions: { rank: number; deadline: string; citations: string[] }[];
      smsText: string;
      bankSummary: string;
      conversationId: string;
      deliveries: { channel: string; status: string }[];
    };
    expect(result.actions.length).toBeGreaterThanOrEqual(3);
    expect(result.actions.length).toBeLessThanOrEqual(5);
    expect(result.actions.map((a) => a.rank)).toEqual(result.actions.map((_, i) => i + 1));
    for (const action of result.actions) {
      expect(action.citations.length).toBeGreaterThan(0);
      expect(Date.parse(action.deadline)).toBeLessThanOrEqual(Date.parse(event.windowEnd));
    }
    expect(result.smsText.length).toBeLessThanOrEqual(160);
    expect(result.smsText).toContain("Reply or open chat");
    expect(sent.filter((m) => m.channel === "email")).toHaveLength(2);
    expect(result.deliveries.map((d) => d.status)).toEqual(["unavailable", "dry_run", "dry_run"]);
    expect(result.bankSummary).not.toBe("");
    expect((await advisor.getLoanState("LN-0142")).state).toBe("ALERT");

    // The thread opens with the advice, so the owner can ask follow-ups
    expect((await repo.listMessages(result.conversationId))[0]?.role).toBe("assistant");
    const followUp = await advisor.handleChat({
      businessId: "SME-0142",
      conversationId: result.conversationId,
      message: "What should I do first?",
    });
    expect(followUp.mode).toBe("alert");

    now = new Date("2026-10-10T06:00:00Z");
    expect(await advisor.sweepAlerts()).toEqual([]);
    now = new Date(Date.parse(event.windowEnd) + 1000);
    expect(await advisor.sweepAlerts()).toEqual(["LN-0142"]);
    const state = await advisor.getLoanState("LN-0142");
    expect(state.state).toBe("ACTIVE");
    expect(state.history.map((h) => `${h.from}->${h.to}`)).toEqual(["ACTIVE->ALERT", "ALERT->ACTIVE"]);
  });

  it("skips loans that are not disbursed", async () => {
    const { advisor } = createTestAdvisor();
    const outcome = await advisor.handleAlert(buildFakeAlert({ loanIds: ["LN-0101"] }));
    expect(outcome.results[0]).toMatchObject({ status: "skipped", reason: "loan not disbursed" });
  });

  it("never lets the model dismiss an alert, and tops actions up from the guidelines", async () => {
    const dismissive: LlmClient = {
      version: "test/dismissive",
      complete: () =>
        Promise.resolve({
          content: null,
          toolCalls: [
            {
              id: "r",
              name: "respond",
              arguments: JSON.stringify({
                reply: "This alert is safe to ignore.",
                actions: [],
                bankSummary: "None",
                citations: [],
              }),
            },
          ],
        }),
    };
    const { advisor } = createTestAdvisor({ llm: dismissive });
    const outcome = await advisor.handleAlert(buildFakeAlert({ loanIds: ["LN-0142"] }));
    const result = outcome.results[0] as { reply: string; actions: unknown[]; warnings: string[] };
    expect(result.reply).not.toContain("ignore");
    expect(result.actions).toHaveLength(3);
    expect(result.warnings).toContain("dismissive answer replaced");
  });
});

describe("Mode 3: recovery planner", () => {
  it("collects damage by chat, proposes options, and enters RECOVERY only on a bank accept", async () => {
    const { advisor, repo } = createTestAdvisor();
    await advisor.markDisbursed("LN-0101");

    const intake = await advisor.handleDamageReport({
      loanId: "LN-0101",
      message: "Shop closed 6 days, ₹40k stock lost.",
    });
    expect(intake.mode).toBe("recovery");
    expect(intake.proposal).toBeUndefined();
    expect(intake.structured?.questions).toHaveLength(2);
    expect((await advisor.getLoanState("LN-0101")).damage).toMatchObject({ daysClosed: 6, stockLossInr: 40_000 });

    const plan = await advisor.handleChat({
      businessId: "SME-0101",
      conversationId: intake.conversationId,
      message: "No equipment damage. Reopened on 2026-10-09, and no insurance claim.",
    });
    expect(plan.proposal?.status).toBe("pending_bank");
    expect(plan.proposal?.options.length).toBeGreaterThanOrEqual(3);
    expectTraceable(plan, await repo.listToolCalls(intake.conversationId));
    expect((await advisor.getLoanState("LN-0101")).state).toBe("IMPACTED");

    const proposalId = plan.proposal?.id ?? "";
    const decided = await advisor.decideProposal(proposalId, { decision: "accept", note: "ok", decidedBy: "officer-7" });
    expect(decided.proposal.status).toBe("accepted");
    expect(decided.loanState.state).toBe("RECOVERY");
    await expect(advisor.decideProposal(proposalId, { decision: "reject" })).rejects.toBeInstanceOf(ConflictError);

    const closed = await advisor.closeRecovery("LN-0101");
    expect(closed.history.map((h) => h.to)).toEqual(["ACTIVE", "IMPACTED", "RECOVERY", "ACTIVE"]);
  });

  it("goes straight to options when the report is complete, with an insurance bridge", async () => {
    const { advisor } = createTestAdvisor();
    const result = await advisor.handleDamageReport({
      loanId: "LN-0142",
      daysClosed: 6,
      stockLossInr: 40_000,
      equipmentDamageInr: 15_000,
      expectedReopenDate: "2026-10-12",
      insuranceClaim: { status: "filed", expectedAmountInr: 30_000, expectedDate: "2026-12-15" },
    });
    const kinds = (result.proposal?.options as { kind: string }[]).map((o) => o.kind);
    expect(kinds).toEqual(["moratorium", "tenure_extension", "step_down_up", "insurance_bridge"]);
  });

  it("refuses a damage report on a loan that is not disbursed", async () => {
    const { advisor } = createTestAdvisor();
    await expect(advisor.handleDamageReport({ loanId: "LN-0203", daysClosed: 2 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe("agent loop", () => {
  // Replays a fixed list of replies, one per model call; the last one repeats
  const scripted = (replies: LlmReply[]) => {
    const client = {
      version: "test/scripted",
      calls: 0,
      complete() {
        const reply = replies[Math.min(client.calls, replies.length - 1)];
        client.calls += 1;
        return Promise.resolve(reply ?? { content: null, toolCalls: [] });
      },
    };
    return client;
  };
  const respond = (args: unknown): LlmReply => ({
    content: null,
    toolCalls: [{ id: "r", name: "respond", arguments: JSON.stringify(args) }],
  });
  const tool = (name: string, args: unknown = {}): LlmReply => ({
    content: null,
    toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
  });
  const plain = (reply: string, citations: string[] = []) =>
    respond({ reply, questions: [], assessment: null, citations });

  it("runs one repair pass when the answer has a number with no source", async () => {
    const llm = scripted([
      tool("getEvaluation"),
      plain("Your EMI would be ₹9,999."),
      plain("Your annual revenue is ₹21,48,000.", ["call_1.business.annualRevenue"]),
    ]);
    const { advisor } = createTestAdvisor({ llm });
    const result = await advisor.handleChat({ businessId: "SME-0101", message: "How am I doing?" });
    expect(llm.calls).toBe(3);
    expect(result.reply).toBe("Your annual revenue is ₹21,48,000.");
    expect(result.citations).toEqual(["call_1.business.annualRevenue"]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps the answer but flags it when the repair pass does not fix it", async () => {
    const llm = scripted([plain("Expect a loss of ₹77,777.", ["call_9"])]);
    const { advisor } = createTestAdvisor({ llm });
    const result = await advisor.handleChat({ businessId: "SME-0101", message: "hi" });
    expect(llm.calls).toBe(2);
    expect(result.citations).toEqual([]);
    expect(result.warnings.join(" ")).toContain("₹77,777");
  });

  it("stops at the iteration limit and reports without inventing numbers", async () => {
    const llm = scripted([tool("getWeatherImpact")]);
    const { advisor } = createTestAdvisor({ llm });
    const result = await advisor.handleChat({ businessId: "SME-0101", message: "hi" });
    expect(llm.calls).toBe(8);
    expect(result.warnings).toEqual(["iteration_limit"]);
    expect(result.reply).toContain("step limit");
    expect(result.reply).not.toMatch(/₹/);
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const llm = scripted([
      tool("simulateScenario", { hazard: "flood", durationDays: 3, month: 7 }),
      plain("That data is unavailable right now."),
    ]);
    const { advisor, repo } = createTestAdvisor({ llm });
    const result = await advisor.handleChat({ businessId: "SME-0101", message: "hi" });
    expect(result.toolCalls[0]).toMatchObject({ tool: "simulateScenario", ok: false });
    expect((await repo.listToolCalls(result.conversationId))[0]?.error).toContain("Invalid arguments");
  });

  it("cannot call a tool from another mode", async () => {
    const llm = scripted([tool("generateRepaymentOptions"), plain("ok")]);
    const { advisor } = createTestAdvisor({ llm });
    const result = await advisor.handleChat({ businessId: "SME-0101", message: "hi" });
    expect(result.toolCalls[0]?.error).toContain("not available in preLoan mode");
  });
});
