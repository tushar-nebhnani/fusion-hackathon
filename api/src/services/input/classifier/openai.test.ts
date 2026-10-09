import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { INPUT } from "../config.js";
import { validReply } from "../testing/fixtures.js";
import { createOpenAiClassifier } from "./openai.js";

// A stand-in for the OpenAI client that answers with `response`
function fakeClient(response: object) {
  const parse = vi.fn().mockResolvedValue(response);
  const client = { responses: { parse } } as unknown as Pick<OpenAI, "responses">;
  const sent = () => parse.mock.calls[0]?.[0] as Record<string, unknown>;
  return { client, parse, sent };
}

const completed = { status: "completed", output: [], output_parsed: validReply() };
const REQUEST = { system: "the system prompt", user: '{"sector":"retail"}' };

describe("createOpenAiClassifier", () => {
  it("asks for a structured reply at temperature 0 and does not store the request", async () => {
    const { client, sent } = fakeClient(completed);
    const llm = createOpenAiClassifier({ apiKey: "test", model: "gpt-4.1-mini", client });

    const reply = await llm.complete(REQUEST);

    expect(reply).toEqual(validReply());
    expect(llm.model).toBe("gpt-4.1-mini");
    expect(sent()).toMatchObject({
      model: "gpt-4.1-mini",
      instructions: REQUEST.system,
      input: REQUEST.user,
      temperature: 0,
      store: false,
      max_output_tokens: INPUT.classifier.maxTokens,
      text: { format: { type: "json_schema", name: "weather_impact_profile" } },
    });
    expect(sent()).not.toHaveProperty("reasoning");
  });

  it("sends a reasoning model a low effort instead of a temperature", async () => {
    const { client, sent } = fakeClient(completed);
    const llm = createOpenAiClassifier({ apiKey: "test", model: "gpt-5-nano", client });

    await llm.complete(REQUEST);

    expect(sent()).toMatchObject({ reasoning: { effort: "low" } });
    expect(sent()).not.toHaveProperty("temperature");
  });

  it("throws when the model declines", async () => {
    const { client } = fakeClient({
      status: "completed",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }],
      output_parsed: null,
    });
    const llm = createOpenAiClassifier({ apiKey: "test", model: "gpt-4.1-mini", client });

    await expect(llm.complete(REQUEST)).rejects.toThrow("request declined");
  });

  it("throws when the reply is cut off or missing", async () => {
    for (const response of [
      { status: "incomplete", output: [], output_parsed: validReply() },
      { status: "completed", output: [], output_parsed: null },
    ]) {
      const { client } = fakeClient(response);
      const llm = createOpenAiClassifier({ apiKey: "test", model: "gpt-4.1-mini", client });

      await expect(llm.complete(REQUEST)).rejects.toThrow("cut off");
    }
  });

  it("passes an API failure on to the caller", async () => {
    const { client, parse } = fakeClient(completed);
    parse.mockRejectedValueOnce(new Error("rate limited"));
    const llm = createOpenAiClassifier({ apiKey: "test", model: "gpt-4.1-mini", client });

    await expect(llm.complete(REQUEST)).rejects.toThrow("rate limited");
  });
});
