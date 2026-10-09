import type { ClimateProfile } from "../../climate/schema.js";
import { HAZARDS, type Hazard } from "../../climate/types.js";
import { createEvaluatorService } from "../../evaluator/service.js";
import { loadAdvisorConfig } from "../config.js";
import { loadDirectory } from "../directory.js";
import { createAdvisor, type AdvisorDeps } from "../index.js";
import type { LlmClient } from "../llm/client.js";
import { createOfflineLlm } from "../llm/offline.js";
import type { Contacts, Messenger, OutgoingMessage } from "../tools/messaging.js";
import { createMemoryAdvisorRepository } from "./memory-repository.js";

type Rated = Partial<Record<Hazard, { relevance: "primary" | "secondary"; score: number }>>;

// A profile in the climate unit's exact shape; unrated hazards are dormant
export function climateProfile(rated: Rated): ClimateProfile {
  return {
    location: { lat: 0, lon: 0, cells: { historical: "h", climate: "c", flood: "f", forecast: "fc" } },
    overall_climate_risk: 0.5,
    grade: "C",
    confidence: "med",
    hazards: HAZARDS.map((hazard) => {
      const entry = rated[hazard];
      return {
        hazard,
        relevance: entry?.relevance ?? "dormant",
        relevance_method: "static" as const,
        score: entry?.score ?? 0.05,
        components: { historical: entry?.score ?? 0.05, forecast: 0 },
        reason: `test reason for ${hazard}`,
      };
    }),
    active_events: [],
    data_freshness: { forecast_issued_at: null, history_until: "2026-10-01" },
    cache: "complete_hit",
    warnings: [],
  };
}

// Keyed by the coordinates in api/data/smes.json
export const PROFILES: Record<string, ClimateProfile> = {
  "19.8,85.82": climateProfile({
    river_flood: { relevance: "primary", score: 0.7 },
    storm: { relevance: "secondary", score: 0.5 },
  }),
  "13.08,80.27": climateProfile({
    river_flood: { relevance: "primary", score: 0.6 },
    heat: { relevance: "secondary", score: 0.4 },
  }),
  "18.4,76.58": climateProfile({
    drought: { relevance: "primary", score: 0.7 },
    heat: { relevance: "secondary", score: 0.5 },
  }),
  "26.91,75.79": climateProfile({ heat: { relevance: "primary", score: 0.6 } }),
};

export const OWNER_STEPS = [
  "Check that drains and gutters around the premises are clear",
  "Note which stock, machines and records sit at floor level",
  "Keep important documents together in a waterproof bag",
];

export function createTestAdvisor(options: { llm?: LlmClient; now?: () => Date; climateDown?: boolean } = {}) {
  const memory = createMemoryAdvisorRepository();
  const sent: OutgoingMessage[] = [];
  const messenger: Messenger = {
    send(message) {
      sent.push(message);
      return Promise.resolve(
        message.channel === "sms"
          ? { channel: "sms", to: "****", status: "unavailable", provider: null, error: "No SMS channel" }
          : { channel: "email", to: "****", status: "dry_run", provider: "dry_run", providerRef: `test-${sent.length}` },
      );
    },
  };
  const contacts: Contacts = {
    ownerEmail: "owner@example.com",
    ownerPhone: "+910000000000",
    bankEmails: ["bank@example.com"],
  };
  const deps: AdvisorDeps = {
    repo: memory.repo,
    directory: loadDirectory(loadAdvisorConfig({}).smesPath),
    // The real evaluator over a stand-in climate unit. Demo businesses have
    // no finance profile, so only the climate side is evaluated.
    evaluator: createEvaluatorService({
      climate: {
        getProfile: (point) => {
          if (options.climateDown) return Promise.reject(new Error("Climate data sources are unavailable"));
          const profile = PROFILES[`${point.lat},${point.lon}`];
          return profile ? Promise.resolve(profile) : Promise.reject(new Error("no test profile"));
        },
      },
      now: options.now ?? (() => new Date("2026-10-09T06:00:00Z")),
      logger: { error: () => undefined, warn: () => undefined },
    }),
    messenger,
    contacts: { forBusiness: () => Promise.resolve(contacts) },
    llm: options.llm ?? createOfflineLlm(),
    maxIterations: 8,
    ownerSteps: () => OWNER_STEPS,
    now: options.now ?? (() => new Date("2026-10-09T06:00:00Z")),
  };
  return { advisor: createAdvisor(deps), ...memory, sent };
}
