import { withTimeout } from "../../alerts/withTimeout.js";
import { raises, type ClimateAgent } from "../agent.js";
import type { DetailedProfile } from "../profile.service.js";
import { HAZARDS, type Hazard } from "../types.js";
import type { RunLogger } from "./ports.js";
import { baseTripwires, highest, suddenChanges } from "./rules.js";
import {
  LEVEL_RANK,
  type AgentRaises,
  type CellState,
  type Finding,
  type MonitorLevel,
  type MonitorSettings,
  type RuleResult,
} from "./types.js";

// The optional second opinion. It reuses the climate unit's agent (its
// forecast scoring call) and the unit's add-or-raise guard, so the final
// level of a hazard is always max(rule level, agent level). The rules never
// wait on it for long, and never depend on it.

const HOUR_MS = 3_600_000;

type ReviewSettings = Pick<
  MonitorSettings,
  "agentTimeoutMs" | "agentReviewHours" | "agentLevels" | "rain"
>;

export interface AgentReviewDeps {
  // MONITOR_AGENT_ENABLED
  enabled: boolean;
  agent?: ClimateAgent;
  settings: ReviewSettings;
  logger: RunLogger;
}

export interface Reviewed {
  result: RuleResult;
  lastAgentReviewAt: Date | null;
  // Raises still in force, stored in the snapshot for later checks
  agent?: AgentRaises;
}

export type AgentReviewer = (
  cell: CellState,
  detailed: DetailedProfile,
  rules: RuleResult,
  now: Date,
) => Promise<Reviewed>;

// Used when no reviewer is wired in: the rule result stands
export const noAgentReview: AgentReviewer = (cell, _detailed, rules) =>
  Promise.resolve({ result: rules, lastAgentReviewAt: cell.lastAgentReviewAt });

function levelOf(score: number, settings: ReviewSettings): MonitorLevel {
  if (score >= settings.agentLevels.warning) return "WARNING";
  if (score >= settings.agentLevels.watch) return "WATCH";
  return "NORMAL";
}

// Applies the agent's raises on top of the rule result. Only a level above
// the rules' own counts; anything else leaves the hazard exactly as it was.
function applyRaises(
  rules: RuleResult,
  agent: AgentRaises,
  cell: CellState,
  detailed: DetailedProfile,
  settings: ReviewSettings,
): RuleResult {
  const base = baseTripwires(detailed.forecast.riverHistory, settings);
  const levels = { ...rules.levels };
  const findings = [...rules.findings];

  for (const hazard of HAZARDS) {
    const raise = agent.raises[hazard];
    if (!raise || !raises(LEVEL_RANK, levels[hazard], raise.level)) continue;
    const index = findings.findIndex((finding) => finding.hazard === hazard);
    const existing = index === -1 ? undefined : findings[index];
    const raised: Finding = {
      hazard,
      level: raise.level,
      windowStart: existing?.windowStart ?? detailed.forecast.window.start,
      windowEnd: existing?.windowEnd ?? detailed.forecast.window.end,
      evidence: existing
        ? `${existing.evidence}. Agent review: ${raise.note}`
        : `Agent review: ${raise.note}`,
      dormant: existing?.dormant ?? false,
      source: "agent",
      tripwire: existing?.tripwire ?? base[hazard]?.tripwire ?? null,
      values: { ...existing?.values, rule_level: rules.levels[hazard] },
    };
    if (index === -1) findings.push(raised);
    else findings[index] = raised;
    levels[hazard] = raise.level;
  }

  return {
    ...rules,
    levels,
    level: highest(levels),
    findings,
    sudden: suddenChanges(findings, cell.lastSnapshot),
  };
}

export function createAgentReviewer(deps: AgentReviewDeps): AgentReviewer {
  const { agent, settings, logger } = deps;
  const windowMs = settings.agentReviewHours * HOUR_MS;

  return async (cell, detailed, rules, now) => {
    if (!deps.enabled || !agent) {
      return { result: rules, lastAgentReviewAt: cell.lastAgentReviewAt };
    }
    const within = (since: Date) => now.getTime() - since.getTime() < windowMs;

    // Between two reviews the last raises stay in force, so a hazard does
    // not drop and come back just because the agent was not asked
    const earlier = cell.lastSnapshot?.agent;
    let inForce = earlier && within(new Date(earlier.at)) ? earlier : undefined;
    let reviewedAt = cell.lastAgentReviewAt;

    if (!cell.lastAgentReviewAt || !within(cell.lastAgentReviewAt)) {
      try {
        const scores = await withTimeout(
          agent.scoreForecast({
            location: { lat: cell.lat, lon: cell.lon },
            window: detailed.forecast.window,
            weatherHistory: detailed.forecast.weatherHistory,
            riverHistory: detailed.forecast.riverHistory,
            weather: detailed.forecast.weather,
            flood: detailed.forecast.flood,
            hazards: detailed.profile.hazards.map((h) => ({
              hazard: h.hazard,
              category: h.relevance,
              ruleScore: h.components.forecast,
            })),
          }),
          settings.agentTimeoutMs,
          "monitor agent review",
        );

        const fresh: AgentRaises = { at: now.toISOString(), raises: {} };
        const lowered: Hazard[] = [];
        for (const hazard of HAZARDS) {
          const proposed = levelOf(scores[hazard].score, settings);
          if (raises(LEVEL_RANK, rules.levels[hazard], proposed)) {
            fresh.raises[hazard] = { level: proposed, note: scores[hazard].note };
          } else if (LEVEL_RANK[proposed] < LEVEL_RANK[rules.levels[hazard]]) {
            lowered.push(hazard);
          }
        }
        if (lowered.length > 0) {
          logger.info(
            `agent rated ${lowered.join(", ")} below the rules on ${cell.cellId}; ignored, the rule level stands`,
          );
        }
        inForce = fresh;
        reviewedAt = now;
      } catch (error) {
        logger.warn(
          `agent review of ${cell.cellId} failed, rule result kept: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return {
      result: inForce ? applyRaises(rules, inForce, cell, detailed, settings) : rules,
      lastAgentReviewAt: reviewedAt,
      ...(inForce ? { agent: inForce } : {}),
    };
  };
}
