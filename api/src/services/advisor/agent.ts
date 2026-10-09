import { z } from "zod";
import { invalidCitations, sourceNumbers, ungroundedNumbers, type CitableCall } from "./checks.js";
import type { LlmClient, LlmMessage, LlmTool } from "./llm/client.js";
import { toolsFor, type createToolRunner, type ToolResult } from "./tools/index.js";
import type { AdvisorMode } from "./types.js";

export const RESPOND_TOOL = "respond";

export interface AgentRequest<Output> {
  mode: AdvisorMode;
  llm: LlmClient;
  runner: ReturnType<typeof createToolRunner>;
  system: string;
  // Earlier turns of the conversation, as plain user/assistant text
  history: LlmMessage[];
  input: string;
  maxIterations: number;
  output: {
    schema: z.ZodType<Output>;
    texts(output: Output): string[];
    citations(output: Output): string[];
    // Mode-specific problems the model gets one chance to fix
    problems?(output: Output, calls: ToolResult[]): string[];
  };
  // Tool calls from earlier turns: citable, and their numbers are sources
  priorCalls: CitableCall[];
  // Other places a number may come from: the owner's messages, stored facts
  extraSources: unknown[];
}

export type AgentResult<Output> =
  | {
      status: "answered";
      output: Output;
      calls: ToolResult[];
      citations: string[];
      // Problems still there after the one repair pass
      warnings: string[];
      iterations: number;
    }
  | { status: "iteration_limit" | "model_error"; calls: ToolResult[]; error?: string; iterations: number };

function parseArgs(text: string): unknown {
  try {
    return JSON.parse(text || "{}") as unknown;
  } catch {
    return undefined;
  }
}

// README §8: model call → run any tool calls → feed results back → repeat,
// at most `maxIterations` model calls. The turn ends when the model calls
// `respond` with an answer that passes the checks, or after one repair pass.
export async function runAgent<Output>(request: AgentRequest<Output>): Promise<AgentResult<Output>> {
  const { llm, runner, mode, output: spec } = request;
  const { $schema: _ignored, ...respondParameters } = z.toJSONSchema(spec.schema) as Record<string, unknown>;
  const tools: LlmTool[] = [
    ...toolsFor(mode),
    {
      name: RESPOND_TOOL,
      description: "Give your final answer for this turn. Call it exactly once, after the tools you need.",
      parameters: respondParameters,
    },
  ];
  const messages: LlmMessage[] = [
    { role: "system", content: request.system },
    ...request.history,
    { role: "user", content: request.input },
  ];
  const calls: ToolResult[] = [];
  let repaired = false;

  for (let iteration = 1; iteration <= request.maxIterations; iteration += 1) {
    let reply;
    try {
      reply = await llm.complete({ messages, tools, requireTool: true });
    } catch (error) {
      return {
        status: "model_error",
        calls,
        error: error instanceof Error ? error.message : "model call failed",
        iterations: iteration,
      };
    }
    messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls });

    if (reply.toolCalls.length === 0) {
      messages.push({ role: "user", content: `Finish by calling the ${RESPOND_TOOL} tool.` });
      continue;
    }

    // Tools first, so a respond call in the same turn can cite them
    for (const call of reply.toolCalls) {
      if (call.name === RESPOND_TOOL) continue;
      const result = await runner.run(call.name, parseArgs(call.arguments), mode);
      calls.push(result);
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result.forModel) });
    }

    let answered: AgentResult<Output> | null = null;
    for (const call of reply.toolCalls.filter((c) => c.name === RESPOND_TOOL)) {
      // Every tool call needs a tool message, even ones that are ignored
      const answer = (content: unknown) =>
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(content) });
      if (answered) {
        answer({ ignored: "only one respond call counts" });
        continue;
      }
      const parsed = spec.schema.safeParse(parseArgs(call.arguments));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        answer({
          accepted: false,
          error: `Invalid respond arguments at ${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""}`,
        });
        continue;
      }

      const output = parsed.data;
      const citable: CitableCall[] = [...request.priorCalls, ...calls];
      const cited = spec.citations(output);
      const sources = sourceNumbers([
        ...citable.map((c) => c.output),
        ...calls.map((c) => c.input),
        ...request.extraSources,
        request.input,
      ]);
      const badCitations = invalidCitations(cited, citable);
      const problems = [
        ...badCitations.map((c) => `Citation ${c} does not match a successful tool call or one of its fields.`),
        ...ungroundedNumbers(spec.texts(output), sources).map(
          (n) => `The number "${n}" is not in any tool result. Cite the tool field it comes from, or remove it.`,
        ),
        ...(spec.problems?.(output, calls) ?? []),
      ];

      // README §8: one repair pass, then the answer stands with its warnings
      if (problems.length > 0 && !repaired) {
        repaired = true;
        answer({ accepted: false, fixThenCallRespondAgain: problems });
        continue;
      }
      answered = {
        status: "answered",
        output,
        calls,
        citations: [...new Set(cited.filter((c) => !badCitations.includes(c)))],
        warnings: problems,
        iterations: iteration,
      };
      answer({ accepted: true });
    }
    if (answered) return answered;
  }

  return { status: "iteration_limit", calls, iterations: request.maxIterations };
}
