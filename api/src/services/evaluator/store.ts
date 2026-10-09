import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Evaluation } from "./schema.js";

export interface EvaluationRow {
  evaluation: Evaluation;
  requesterId: string | null;
  financeProfileId: number | null;
  climateRef: string | null;
}

export interface EvaluationSummary {
  evaluation_id: number;
  created_at: string;
  evaluator_version: string;
  rating: string;
  reliable: boolean;
  finance_profile_id: number | null;
  climate_ref: string | null;
}

// Where evaluations are kept. Passed in, so the advisor's tests run without
// a database.
export interface EvaluationStore {
  save(row: EvaluationRow): Promise<number>;
  list(businessId: string, limit: number): Promise<EvaluationSummary[]>;
}

// Append only, like finance_profiles
export function createPrismaEvaluationStore(db: PrismaClient): EvaluationStore {
  return {
    async save({ evaluation, requesterId, financeProfileId, climateRef }) {
      const row = await db.evaluation.create({
        data: {
          businessId: evaluation.business_id,
          requesterId,
          evaluatorVersion: evaluation.evaluator_version,
          rating: evaluation.rating,
          reliable: evaluation.reliable,
          financeProfileId,
          climateRef,
          result: evaluation,
        },
        select: { id: true },
      });
      return row.id;
    },
    async list(businessId, limit) {
      const rows = await db.evaluation.findMany({ where: { businessId }, orderBy: { id: "desc" }, take: limit });
      return rows.map((row) => ({
        evaluation_id: row.id,
        created_at: row.createdAt.toISOString(),
        evaluator_version: row.evaluatorVersion,
        rating: row.rating,
        reliable: row.reliable,
        finance_profile_id: row.financeProfileId,
        climate_ref: row.climateRef,
      }));
    },
  };
}
