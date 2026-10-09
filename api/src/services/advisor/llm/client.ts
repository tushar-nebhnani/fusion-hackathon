import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// The small surface the agent loop needs from a model. Providers plug in
// behind it; the loop, tools and checks never see a provider SDK.

export interface LlmToolCall {
  id: string;
  name: string;
  // JSON text, exactly as the model wrote it
  arguments: string;
}

export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface LlmTool {
  name: string;
  description: string;
  // JSON Schema of the arguments
  parameters: Record<string, unknown>;
}

export interface LlmReply {
  content: string | null;
  toolCalls: LlmToolCall[];
}

export interface LlmClient {
  // Stored with each assistant message, e.g. "openai/gpt-5-mini"
  readonly version: string;
  // `requireTool` forces a tool call, so every turn ends with one
  complete(request: { messages: LlmMessage[]; tools: LlmTool[]; requireTool: boolean }): Promise<LlmReply>;
}

const TIMEOUT_MS = 60_000;

function describeFailure(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) return "the API key was rejected";
  if (error instanceof OpenAI.RateLimitError) return "rate limited by the OpenAI API";
  if (error instanceof OpenAI.APIConnectionError) return "could not reach the OpenAI API";
  if (error instanceof OpenAI.APIError) return `OpenAI API error ${String(error.status)}: ${error.message}`;
  return error instanceof Error ? error.message : "unknown error";
}

function toOpenAi(message: LlmMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    default:
      return { role: message.role, content: message.content };
  }
}

export interface OpenAiLlmOptions {
  apiKey: string;
  model: string;
  // Test seam; the real client is built from `apiKey`
  client?: Pick<OpenAI, "chat">;
}

export function createOpenAiLlm(options: OpenAiLlmOptions): LlmClient {
  const client =
    options.client ?? new OpenAI({ apiKey: options.apiKey, timeout: TIMEOUT_MS, maxRetries: 2 });
  return {
    version: `openai/${options.model}`,
    async complete({ messages, tools, requireTool }) {
      try {
        const response = await client.chat.completions.create({
          model: options.model,
          messages: messages.map(toOpenAi),
          tools: tools.map((tool) => ({
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: requireTool ? "required" : "auto",
          // Business data is not kept on OpenAI's side
          store: false,
        });
        const message = response.choices[0]?.message;
        if (!message) throw new Error("empty reply");
        if (message.refusal) throw new Error("request declined");
        return {
          content: message.content,
          toolCalls: (message.tool_calls ?? []).flatMap((call) =>
            call.type === "function"
              ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }]
              : [],
          ),
        };
      } catch (error) {
        throw new Error(`advisor model: ${describeFailure(error)}`, { cause: error });
      }
    },
  };
}
