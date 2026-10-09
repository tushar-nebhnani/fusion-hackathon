import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { applyReview, createOpenAiAgent, type ScreeningReviewInput } from "./agent.js";
import type { HazardProfile } from "./types.js";

const profile: HazardProfile = {
  hazard: "storm",
  relevance: "secondary",
  method: "static",
  indicatorValue: 1.1,
  reason: "Gusts above 60 km/h on 1.1 days per year",
  indicators: { primaryThreshold: 5, projectionAdjustment: 0 },
};

describe("applyReview", () => {
  it("raises the category and keeps both reasons", () => {
    const result = applyReview(
      profile,
      { hazard: "storm", category: "primary", rationale: "Cyclone-prone coast." },
      "v1",
    );

    expect(result).toMatchObject({
      relevance: "primary",
      method: "agent_raised",
      agentVersion: "v1",
      reason: "Gusts above 60 km/h on 1.1 days per year. Agent review: Cyclone-prone coast.",
    });
  });

  it.each(["secondary", "dormant"] as const)("keeps the rule result when the agent says %s", (category) => {
    const result = applyReview(profile, { hazard: "storm", category, rationale: "x" }, "v1");

    expect(result).toEqual({ ...profile, agentVersion: "v1" });
  });

  it("leaves a hazard the agent did not answer for unreviewed", () => {
    expect(applyReview(profile, undefined, "v1")).toBe(profile);
  });
});

// The real agent with the SDK client replaced by a stub
function openai(reply: object | Error) {
  const parse = vi.fn(() =>
    reply instanceof Error
      ? Promise.reject(reply)
      : Promise.resolve({ status: "completed", output: [], output_parsed: null, ...reply }),
  );
  const client = { responses: { parse } } as unknown as Pick<OpenAI, "responses">;
  return { parse, agent: createOpenAiAgent({ apiKey: "test", model: "gpt-5-nano", client }) };
}

const screening: ScreeningReviewInput = {
  location: { lat: 19.8, lon: 85.8 },
  weatherHistory: null,
  riverHistory: null,
  hazards: [
    {
      hazard: "storm",
      description: "Cyclone / strong wind",
      indicatorRule: "Days per year with gusts > 60 km/h",
      indicatorValue: 1.1,
      primaryThreshold: 5,
      dormantThreshold: 0.5,
      ruleCategory: "secondary",
      ruleReason: "Gusts above 60 km/h on 1.1 days per year",
    },
  ],
};

const forecastInput = {
  location: { lat: 19.8, lon: 85.8 },
  window: { start: "2026-10-09", end: "2026-10-15" },
  weatherHistory: null,
  riverHistory: null,
  weather: null,
  flood: null,
  hazards: [
    { hazard: "storm" as const, category: "secondary" as const, ruleScore: 0.2 },
    { hazard: "heat" as const, category: "dormant" as const, ruleScore: 0.1 },
  ],
};

describe("openai agent", () => {
  it("identifies itself by model and prompt version", () => {
    expect(openai({}).agent.version).toBe("gpt-5-nano/agent-1");
  });

  it("sends the screening as JSON and asks for structured output", async () => {
    const { agent, parse } = openai({
      output_parsed: { hazards: [{ hazard: "storm", category: "primary", rationale: "Coast." }] },
    });

    const verdicts = await agent.reviewScreening(screening);

    expect(verdicts).toEqual([{ hazard: "storm", category: "primary", rationale: "Coast." }]);
    const [params] = parse.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params).toMatchObject({
      model: "gpt-5-nano",
      reasoning: { effort: "medium" },
      text: { format: { type: "json_schema", name: "screening_review", strict: true } },
      input: JSON.stringify(screening),
      store: false,
    });
    expect(params).not.toHaveProperty("temperature");
  });

  it("clamps forecast scores to 0-1", async () => {
    const { agent } = openai({
      output_parsed: {
        hazards: [
          { hazard: "storm", score: 1.7, note: "Gusts near 95 km/h on day 3" },
          { hazard: "heat", score: -0.2, note: "Mild" },
        ],
      },
    });

    expect(await agent.scoreForecast(forecastInput)).toEqual({
      storm: { score: 1, note: "Gusts near 95 km/h on day 3" },
      heat: { score: 0, note: "Mild" },
    });
  });

  it("rejects a reply that leaves a hazard out", async () => {
    const { agent } = openai({
      output_parsed: { hazards: [{ hazard: "storm", score: 0.4, note: "" }] },
    });

    await expect(agent.scoreForecast(forecastInput)).rejects.toThrow("reply left out heat");
  });

  it("fails when the model declines", async () => {
    const { agent } = openai({
      output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }],
    });

    await expect(agent.reviewScreening(screening)).rejects.toThrow("request declined");
  });

  it("fails when the reply is cut off", async () => {
    const { agent } = openai({ status: "incomplete" });

    await expect(agent.reviewScreening(screening)).rejects.toThrow("cut off");
  });

  it("names a rejected API key in the error", async () => {
    const rejected = new OpenAI.AuthenticationError(401, undefined, "Incorrect API key", new Headers());

    await expect(openai(rejected).agent.reviewScreening(screening)).rejects.toThrow(
      "OPENAI_API_KEY was rejected",
    );
  });
});
