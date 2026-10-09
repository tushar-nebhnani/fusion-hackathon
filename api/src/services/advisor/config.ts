import "dotenv/config";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Advisor settings are read apart from config/env.ts, like the alert
// system's: a bad advisor setting falls back to its default instead of
// stopping the API.

export interface AdvisorConfig {
  // "openai" calls the model; "offline" runs the deterministic planner in
  // llm/offline.ts so the demo works without a key
  provider: "openai" | "offline";
  model: string;
  apiKey?: string;
  maxIterations: number;
  enableDevRoutes: boolean;
  smesPath: string;
  // The smes.json businesses, behind the input service's. Never in production
  demoBusinesses: boolean;
  // Advise owners after each alert the alert system sent them (monitorAlerts.ts)
  monitorAlerts: boolean;
  // How often loans in ALERT are checked for an ended window, and sent
  // alerts for new ones
  sweepSeconds: number;
}

// api/data/smes.json, whether this runs from src/ or dist/
const DEFAULT_SMES = fileURLToPath(new URL("../../../data/smes.json", import.meta.url));

const optional = z
  .preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional())
  .catch(undefined);

const schema = z.object({
  NODE_ENV: z.string().catch("development"),
  ADVISOR_LLM_PROVIDER: z.enum(["openai", "offline", ""]).catch(""),
  ADVISOR_LLM_MODEL: z.string().min(1).catch("gpt-5-mini"),
  // Falls back to the key the climate agent already uses
  ADVISOR_LLM_API_KEY: optional,
  OPENAI_API_KEY: optional,
  ADVISOR_MAX_ITERATIONS: z.coerce.number().int().min(2).max(20).catch(8),
  // Off unless asked for: the dev routes act on any loan by its id
  ADVISOR_ENABLE_DEV_ROUTES: z.enum(["true", "false"]).catch("false"),
  ADVISOR_SMES_PATH: optional,
  ADVISOR_DEMO_BUSINESSES: z.enum(["true", "false"]).catch("true"),
  ADVISOR_MONITOR_ALERTS: z.enum(["true", "false"]).catch("true"),
  ADVISOR_SWEEP_SECONDS: z.coerce.number().int().min(5).max(3600).catch(60),
});

export function loadAdvisorConfig(source: Record<string, string | undefined> = process.env): AdvisorConfig {
  const env = schema.parse(source);
  const apiKey = env.ADVISOR_LLM_API_KEY ?? env.OPENAI_API_KEY;
  // No provider named: use the model when a key exists, otherwise offline
  const asked = env.ADVISOR_LLM_PROVIDER || (apiKey ? "openai" : "offline");
  return {
    provider: asked === "openai" && !apiKey ? "offline" : asked,
    model: env.ADVISOR_LLM_MODEL,
    apiKey,
    maxIterations: env.ADVISOR_MAX_ITERATIONS,
    // Dev routes never run in production, whatever the flag says
    enableDevRoutes: env.ADVISOR_ENABLE_DEV_ROUTES === "true" && env.NODE_ENV !== "production",
    smesPath: env.ADVISOR_SMES_PATH ?? DEFAULT_SMES,
    demoBusinesses: env.ADVISOR_DEMO_BUSINESSES === "true" && env.NODE_ENV !== "production",
    monitorAlerts: env.ADVISOR_MONITOR_ALERTS === "true",
    sweepSeconds: env.ADVISOR_SWEEP_SECONDS,
  };
}
