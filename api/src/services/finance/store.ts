import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type { FinanceInputs } from "./metrics/compute.js";
import type { FinanceProfile } from "./profile/schema.js";

const json = (value: unknown) => value as Prisma.InputJsonValue;

export type ProfileTrigger = "request" | "first_profile" | "recompute";

// Append only: every generated profile is kept
export async function insertProfile(
  db: PrismaClient,
  data: { trigger: ProfileTrigger; inputs: FinanceInputs; profile: FinanceProfile },
): Promise<void> {
  const { profile } = data;
  await db.financeProfile.create({
    data: {
      businessId: profile.business_id,
      snapshotVersion: profile.inputs.snapshot_version,
      trigger: data.trigger,
      baselineScore: profile.baseline.score,
      adjustedScore: profile.adjusted?.score ?? null,
      scorerSource: profile.baseline.source,
      modelVersion: profile.model_version,
      inputs: json(data.inputs),
      profile: json(profile),
    },
  });
}

export interface ProfileSummary {
  id: number;
  created_at: string;
  trigger: string;
  snapshot_version: number;
  baseline_score: number;
  adjusted_score: number | null;
  scorer_source: string;
  model_version: string;
}

// Newest first
export async function listProfiles(db: PrismaClient, businessId: string, limit: number): Promise<ProfileSummary[]> {
  const rows = await db.financeProfile.findMany({
    where: { businessId },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    trigger: row.trigger,
    snapshot_version: row.snapshotVersion,
    baseline_score: row.baselineScore,
    adjusted_score: row.adjustedScore,
    scorer_source: row.scorerSource,
    model_version: row.modelVersion,
  }));
}

export interface StoredProfile {
  id: number;
  createdAt: Date;
  profile: FinanceProfile;
}

// The newest stored profile, whole, or null when there is none
export async function latestProfile(db: PrismaClient, businessId: string): Promise<StoredProfile | null> {
  const row = await db.financeProfile.findFirst({ where: { businessId }, orderBy: { id: "desc" } });
  return row ? { id: row.id, createdAt: row.createdAt, profile: row.profile as unknown as FinanceProfile } : null;
}

export interface RequestLogEntry {
  requestId: string;
  operation: "profile" | "scenario" | "evaluate_location" | "repayment_capacity";
  businessId: string | null;
  ok: boolean;
  errorCode: string | null;
  sensitivitySource: string | null;
  scorerSource: string | null;
  fallbacks: string[];
  stageMs: Record<string, number>;
  latencyMs: number;
}

export async function logRequest(db: PrismaClient, entry: RequestLogEntry): Promise<void> {
  await db.financeRequestLog.create({
    data: { ...entry, fallbacks: json(entry.fallbacks), stageMs: json(entry.stageMs) },
  });
}
