import { z } from "zod";
import { HAZARDS, type Hazard } from "../types.js";

export const LEVELS = ["NORMAL", "WATCH", "WARNING", "SEVERE"] as const;
export type MonitorLevel = (typeof LEVELS)[number];

export const LEVEL_RANK: Record<MonitorLevel, number> = {
  NORMAL: 0,
  WATCH: 1,
  WARNING: 2,
  SEVERE: 3,
};

export const maxLevel = (a: MonitorLevel, b: MonitorLevel): MonitorLevel =>
  LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;

// The numbers in CLIMATE.monitor that the rules, cadence and jobs read
export interface MonitorSettings {
  intervalHours: Record<MonitorLevel, number>;
  calmRunsToStepDown: number;
  entryTimeoutMs: number;
  firstCheckTimeoutMs: number;
  agentTimeoutMs: number;
  agentReviewHours: number;
  leaseSeconds: number;
  rain: { minProbabilityPct: number; heavyMm: number; veryHeavyMm: number; extremelyHeavyMm: number };
  riverRainWithinHours: number;
  dormantTripLevel: MonitorLevel;
  agentLevels: { watch: number; warning: number };
  verify: { scanDays: number; matchToleranceDays: number };
}

// The threshold a finding crossed. The verification job checks the observed
// value against the same one.
const tripwireSchema = z.object({
  variable: z.string(),
  threshold: z.number(),
  direction: z.enum(["above", "below"]),
});
export type Tripwire = z.infer<typeof tripwireSchema>;

export const crosses = (value: number, tripwire: Tripwire): boolean =>
  tripwire.direction === "above" ? value >= tripwire.threshold : value <= tripwire.threshold;

export type FindingSource = "rules" | "climate_event" | "agent";

// One hazard above NORMAL, with the reason in words
export interface Finding {
  hazard: Hazard;
  level: MonitorLevel;
  windowStart: string;
  windowEnd: string;
  evidence: string;
  // The hazard is dormant here and its tripwire tripped
  dormant: boolean;
  source: FindingSource;
  tripwire: Tripwire | null;
  // Forecast numbers behind the finding; stored with the disaster event
  values: Record<string, number | string | null>;
}

const levelSchema = z.enum(LEVELS);

// Key forecast values of one check, kept for the next comparison
const snapshotValuesSchema = z.object({
  rainMaxMm: z.number().nullable(),
  rainProbabilityPct: z.number().nullable(),
  tmaxC: z.number().nullable(),
  gustKmh: z.number().nullable(),
  dischargeMaxM3s: z.number().nullable(),
  riverHighM3s: z.number().nullable(),
  // The climate unit's forecast score per hazard
  forecastScores: z.record(z.enum(HAZARDS), z.number()),
});
export type SnapshotValues = z.infer<typeof snapshotValuesSchema>;

// Shape of `monitored_cells.last_snapshot`. Anything else counts as no snapshot.
export const snapshotSchema = z.object({
  at: z.string(),
  levels: z.record(z.enum(HAZARDS), levelSchema),
  values: snapshotValuesSchema,
  // The agent's last raises, reused until its next review is due
  agent: z
    .object({
      at: z.string(),
      raises: z.partialRecord(z.enum(HAZARDS), z.object({ level: levelSchema, note: z.string() })),
    })
    .optional(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type AgentRaises = NonNullable<Snapshot["agent"]>;

export interface RuleResult {
  levels: Record<Hazard, MonitorLevel>;
  // Highest hazard level
  level: MonitorLevel;
  findings: Finding[];
  // Findings whose level is higher than in the last snapshot
  sudden: Finding[];
  values: SnapshotValues;
}

export interface CellState {
  cellId: string;
  lat: number;
  lon: number;
  active: boolean;
  level: MonitorLevel;
  calmRuns: number;
  nextCheckAt: Date;
  lastCheckedAt: Date | null;
  lastSnapshot: Snapshot | null;
  lastAgentReviewAt: Date | null;
  createdAt: Date;
}

export type DisasterEventStatus = "pending" | "hit" | "false_alarm" | "missed";

export interface NewDisasterEvent {
  cellId: string;
  hazard: Hazard;
  level: MonitorLevel;
  windowStart: string;
  windowEnd: string;
  forecastValues: Record<string, unknown>;
  evidence: string;
  sourceRunId: string | null;
}

// Shape of `disaster_events.forecast_values` as far as verification needs it
export const forecastValuesSchema = z.looseObject({ tripwire: tripwireSchema.nullable() });

export const isHazard = (value: string): value is Hazard =>
  (HAZARDS as readonly string[]).includes(value);
