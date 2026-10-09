import { describe, expect, it } from "vitest";
import type { ClimateAgent } from "../agent.js";
import { fakeAgent } from "../testing/fake-agent.js";
import type { Hazard } from "../types.js";
import { createAgentReviewer, noAgentReview } from "./agentReview.js";
import { evaluateRules } from "./rules.js";
import {
  HOUR_MS,
  SETTINGS,
  START,
  cellOf,
  detailedOf,
  memoryLogger,
  never,
  snapshotOf,
  type DetailScript,
} from "./testing/fixtures.js";
import type { CellState } from "./types.js";

// The climate unit's scripted agent: it echoes the rule score unless a test
// gives a hazard a score of its own
function setup(scores: Partial<Record<Hazard, number>> = {}, enabled = true) {
  const fake = fakeAgent({ scores });
  const log = memoryLogger();
  const review = createAgentReviewer({
    enabled,
    agent: fake.agent,
    settings: SETTINGS,
    logger: log.logger,
  });
  const run = (script: DetailScript = {}, cell: CellState = cellOf(), now = START) => {
    const detailed = detailedOf(script);
    const rules = evaluateRules({
      now,
      profile: detailed.profile,
      forecast: detailed.forecast,
      previous: cell.lastSnapshot,
      settings: SETTINGS,
    });
    return review(cell, detailed, rules, now).then((reviewed) => ({ reviewed, rules }));
  };
  return { fake, log, run };
}

describe("agent review", () => {
  it("raises a hazard the rules left at NORMAL", async () => {
    const { run } = setup({ heat: 0.7 });

    const { reviewed } = await run();

    expect(reviewed.result.levels.heat).toBe("WATCH");
    expect(reviewed.result.level).toBe("WATCH");
    expect(reviewed.result.sudden).toMatchObject([
      {
        hazard: "heat",
        level: "WATCH",
        source: "agent",
        evidence: "Agent review: fake note for heat",
        windowStart: "2026-10-09",
        windowEnd: "2026-10-15",
        tripwire: { variable: "temperature_2m_max", threshold: 40 },
      },
    ]);
    expect(reviewed.lastAgentReviewAt).toEqual(START);
  });

  it("gives the higher of the rule level and the agent level", async () => {
    const { run } = setup({ heat: 0.9 });

    const { reviewed, rules } = await run({ weather: { tmax: [41] } });

    expect(rules.levels.heat).toBe("WATCH");
    expect(reviewed.result.levels.heat).toBe("WARNING");
    expect(reviewed.result.sudden[0]?.evidence).toBe(
      "41 °C max temperature forecast on 9 Oct. Agent review: fake note for heat",
    );
  });

  it("ignores an agent that tries to lower a level, and says so", async () => {
    const { run, log } = setup({ heat: 0 });

    const { reviewed, rules } = await run({ weather: { tmax: [46] } });

    expect(reviewed.result.levels.heat).toBe("WARNING");
    expect(reviewed.result).toEqual(rules);
    expect(log.of("info")).toEqual([
      "agent rated heat below the rules on 0.1:13.1:80.3; ignored, the rule level stands",
    ]);
  });

  it("cannot remove a hazard the rules found", async () => {
    const { run } = setup({ flash_flood: 0, heat: 0, storm: 0 });

    const { reviewed, rules } = await run({ weather: { rain: [130], tmax: [0, 46], gust: [0, 0, 70] } });

    expect(reviewed.result.findings).toEqual(rules.findings);
    expect(reviewed.result.sudden.map((f) => f.hazard)).toEqual(["flash_flood", "heat", "storm"]);
  });

  it("cannot raise a hazard to SEVERE", async () => {
    const { run } = setup({ storm: 1 });

    expect((await run()).reviewed.result.levels.storm).toBe("WARNING");
  });

  it("changes nothing when it agrees with the rules", async () => {
    const { run, fake } = setup();

    const { reviewed, rules } = await run({ weather: { tmax: [41] } });

    expect(fake.calls).toEqual(["score"]);
    expect(reviewed.result).toEqual(rules);
  });

  it("hands the agent the forecast values and the unit's scores", async () => {
    const { run, fake } = setup();

    await run({ weather: { rain: [0, 82] }, flood: [600, 900], forecastScores: { heat: 0.4 } });

    expect(fake.scored[0]).toMatchObject({
      location: { lat: 13.0827, lon: 80.2707 },
      window: { start: "2026-10-09", end: "2026-10-15" },
      riverHistory: { dischargeP99: 1000 },
    });
    expect(fake.scored[0]?.weather?.values.precipitation_sum?.[1]).toBe(82);
    expect(fake.scored[0]?.hazards.find((h) => h.hazard === "heat")).toEqual({
      hazard: "heat",
      category: "primary",
      ruleScore: 0.4,
    });
  });

  it("keeps the rule result when the agent times out", async () => {
    const log = memoryLogger();
    const slow: ClimateAgent = {
      version: "slow/1",
      reviewScreening: () => never(),
      scoreForecast: () => never(),
    };
    const review = createAgentReviewer({
      enabled: true,
      agent: slow,
      settings: { ...SETTINGS, agentTimeoutMs: 20 },
      logger: log.logger,
    });
    const detailed = detailedOf({ weather: { tmax: [46] } });
    const rules = evaluateRules({
      now: START,
      profile: detailed.profile,
      forecast: detailed.forecast,
      previous: null,
      settings: SETTINGS,
    });

    const reviewed = await review(cellOf(), detailed, rules, START);

    expect(reviewed.result).toEqual(rules);
    expect(reviewed.lastAgentReviewAt).toBeNull();
    expect(log.of("warn")[0]).toMatch(/agent review of 0\.1:13\.1:80\.3 failed, rule result kept: .*timed out after 20 ms/);
  });

  it("keeps the rule result when the agent fails", async () => {
    const { run, fake, log } = setup({ heat: 0.9 });
    fake.state.failing = true;

    const { reviewed, rules } = await run({ weather: { tmax: [41] } });

    expect(reviewed.result).toEqual(rules);
    expect(log.of("warn")[0]).toContain("agent down");
  });

  it("is not called at all when MONITOR_AGENT_ENABLED is off", async () => {
    const { run, fake } = setup({ heat: 0.9 }, false);

    const { reviewed, rules } = await run();

    expect(fake.calls).toEqual([]);
    expect(reviewed.result).toEqual(rules);
  });

  it("is asked at most once every 6 hours per cell", async () => {
    const { run, fake } = setup({ heat: 0.7 });
    const reviewedAt = START;
    const later = (hours: number) => new Date(START.getTime() + hours * HOUR_MS);

    await run({}, cellOf({ lastAgentReviewAt: reviewedAt }), later(1));
    await run({}, cellOf({ lastAgentReviewAt: reviewedAt }), later(5.9));
    expect(fake.calls).toEqual([]);

    await run({}, cellOf({ lastAgentReviewAt: reviewedAt }), later(6));
    expect(fake.calls).toEqual(["score"]);
  });

  it("keeps its last raise in force between two reviews", async () => {
    const { run, fake } = setup({ heat: 0.7 });
    const first = await run();
    const snapshot = { ...snapshotOf({ heat: "WATCH" }), agent: first.reviewed.agent };
    fake.calls.length = 0;

    // An hour later the agent is not asked again, and heat does not drop
    // back to NORMAL only to be raised, and alerted on, a second time
    const cell = cellOf({ lastSnapshot: snapshot, lastAgentReviewAt: START, level: "WATCH" });
    const second = await run({}, cell, new Date(START.getTime() + HOUR_MS));

    expect(fake.calls).toEqual([]);
    expect(second.reviewed.result.levels.heat).toBe("WATCH");
    expect(second.reviewed.result.sudden).toEqual([]);
  });

  it("drops a raise once it is older than the review interval", async () => {
    const { run, fake } = setup({ heat: 0.7 });
    const first = await run();
    fake.state.failing = true;

    const cell = cellOf({
      lastSnapshot: { ...snapshotOf({ heat: "WATCH" }), agent: first.reviewed.agent },
      lastAgentReviewAt: START,
    });
    const second = await run({}, cell, new Date(START.getTime() + 7 * HOUR_MS));

    expect(second.reviewed.result.levels.heat).toBe("NORMAL");
  });

  it("leaves the rules alone when no reviewer is wired in", async () => {
    const detailed = detailedOf({ weather: { tmax: [46] } });
    const rules = evaluateRules({
      now: START,
      profile: detailed.profile,
      forecast: detailed.forecast,
      previous: null,
      settings: SETTINGS,
    });

    expect(await noAgentReview(cellOf(), detailed, rules, START)).toEqual({
      result: rules,
      lastAgentReviewAt: null,
    });
  });
});
