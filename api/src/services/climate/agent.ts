import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { CLIMATE } from "../../config/climate.js";
import { FORECAST_PROMPT, SCREENING_PROMPT } from "../../prompts/climate.js";
import { clamp01 } from "./scoring.js";
import {
  HAZARDS,
  type Hazard,
  type HazardProfile,
  type LatLon,
  type Relevance,
  type RiverIndicators,
  type TimeSeries,
  type WeatherIndicators,
} from "./types.js";

export interface ScreeningReviewInput {
  location: LatLon;
  weatherHistory: WeatherIndicators | null;
  riverHistory: RiverIndicators | null;
  hazards: {
    hazard: Hazard;
    description: string;
    indicatorRule: string;
    indicatorValue: number | null;
    primaryThreshold: number;
    dormantThreshold: number;
    ruleCategory: Relevance;
    ruleReason: string;
  }[];
}

export interface ScreeningVerdict {
  hazard: Hazard;
  category: Relevance;
  rationale: string;
}

export interface ForecastScoreInput {
  location: LatLon;
  window: { start: string; end: string };
  weatherHistory: WeatherIndicators | null;
  riverHistory: RiverIndicators | null;
  // Daily values for the window; null when that forecast is unavailable
  weather: TimeSeries | null;
  flood: TimeSeries | null;
  hazards: { hazard: Hazard; category: Relevance; ruleScore: number }[];
}

export type ForecastScores = Record<Hazard, { score: number; note: string }>;

// The two places a model is consulted. Implementations throw on any failure;
// the pipeline then carries on with the rule-based result.
export interface ClimateAgent {
  // Stored as `agent_version` with every decision it reviews
  version: string;
  // Fetch 1: checks each hazard's rule-based category
  reviewScreening(input: ScreeningReviewInput): Promise<ScreeningVerdict[]>;
  // Fetch 2: scores how threatening the forecast window is, per hazard
  scoreForecast(input: ForecastScoreInput): Promise<ForecastScores>;
}

const RANK: Record<Relevance, number> = { dormant: 0, secondary: 1, primary: 2 };

// The agent can confirm a category or raise it, never lower it: a model must
// not be able to argue a measured hazard away. Either way the profile is
// marked as reviewed.
export function applyReview(
  profile: HazardProfile,
  verdict: ScreeningVerdict | undefined,
  version: string,
): HazardProfile {
  if (!verdict) return profile;
  const reviewed = { ...profile, agentVersion: version };
  if (RANK[verdict.category] <= RANK[profile.relevance]) return reviewed;
  return {
    ...reviewed,
    relevance: verdict.category,
    method: "agent_raised",
    reason: `${profile.reason}. Agent review: ${verdict.rationale}`,
  };
}

const screeningOutput = z.object({
  hazards: z.array(
    z.object({
      hazard: z.enum(HAZARDS),
      category: z.enum(["primary", "secondary", "dormant"]),
      rationale: z.string(),
    }),
  ),
});

const forecastOutput = z.object({
  hazards: z.array(
    z.object({
      hazard: z.enum(HAZARDS),
      score: z.number(),
      note: z.string(),
    }),
  ),
});

type Effort = "low" | "medium" | "high";

function describeFailure(error: unknown): string {
  if (error instanceof OpenAI.AuthenticationError) return "OPENAI_API_KEY was rejected";
  if (error instanceof OpenAI.RateLimitError) return "rate limited by the OpenAI API";
  if (error instanceof OpenAI.APIConnectionError) return "could not reach the OpenAI API";
  if (error instanceof OpenAI.APIError) {
    return `OpenAI API error ${String(error.status)}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "unknown error";
}

export interface OpenAiAgentOptions {
  apiKey: string;
  model: string;
  // Test seam; the real client is built from `apiKey`
  client?: Pick<OpenAI, "responses">;
}

export function createOpenAiAgent(options: OpenAiAgentOptions): ClimateAgent {
  const client =
    options.client ??
    new OpenAI({
      apiKey: options.apiKey,
      timeout: CLIMATE.agent.timeoutMs,
      maxRetries: CLIMATE.agent.maxRetries,
    });

  async function ask<Schema extends z.ZodType>(
    schema: Schema,
    name: string,
    system: string,
    input: unknown,
    effort: Effort,
  ): Promise<z.infer<Schema>> {
    try {
      const response = await client.responses.parse({
        model: options.model,
        // Covers reasoning as well as the reply
        max_output_tokens: CLIMATE.agent.maxTokens,
        instructions: system,
        input: JSON.stringify(input),
        reasoning: { effort },
        text: { format: zodTextFormat(schema, name) },
        // Locations are not kept on OpenAI's side
        store: false,
      });
      const refused = response.output.some(
        (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
      );
      if (refused) throw new Error("request declined");
      if (response.status === "incomplete" || response.output_parsed === null) {
        throw new Error("reply was cut off or did not match the expected shape");
      }
      return response.output_parsed as z.infer<Schema>;
    } catch (error) {
      throw new Error(`climate agent: ${describeFailure(error)}`, { cause: error });
    }
  }

  // The reply must cover every hazard that was asked about, once
  function byHazard<T extends { hazard: Hazard }>(asked: Hazard[], entries: T[]): Map<Hazard, T> {
    const found = new Map(entries.map((entry) => [entry.hazard, entry]));
    const missing = asked.filter((hazard) => !found.has(hazard));
    if (missing.length > 0) {
      throw new Error(`climate agent: reply left out ${missing.join(", ")}`);
    }
    return found;
  }

  return {
    version: `${options.model}/${CLIMATE.agent.promptVersion}`,

    async reviewScreening(input) {
      const asked = input.hazards.map((h) => h.hazard);
      const reply = await ask(screeningOutput, "screening_review", SCREENING_PROMPT, input, "medium");
      const found = byHazard(asked, reply.hazards);
      return asked.map((hazard) => found.get(hazard) as ScreeningVerdict);
    },

    async scoreForecast(input) {
      const asked = input.hazards.map((h) => h.hazard);
      const reply = await ask(forecastOutput, "forecast_scores", FORECAST_PROMPT, input, "low");
      const found = byHazard(asked, reply.hazards);
      const scores = {} as ForecastScores;
      for (const { hazard, ruleScore } of input.hazards) {
        const entry = found.get(hazard);
        const score = entry && Number.isFinite(entry.score) ? clamp01(entry.score) : ruleScore;
        scores[hazard] = { score, note: entry?.note ?? "" };
      }
      return scores;
    },
  };
}
