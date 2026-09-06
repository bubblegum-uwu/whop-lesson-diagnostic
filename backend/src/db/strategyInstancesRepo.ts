import type { Pool, PoolClient } from "pg";
import type { Strategy } from "../gemini/schema.js";

export type Queryable = Pool | PoolClient;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function createStrategyInstances(
  db: Queryable,
  analysisId: number,
  lessonId: number,
  strategies: Strategy[],
): Promise<void> {
  for (const strategy of strategies) {
    await db.query(
      `INSERT INTO strategy_instances (analysis_id, lesson_id, strategy_name, normalized_name, validated_strategy_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [analysisId, lessonId, strategy.strategy_name, normalizeName(strategy.strategy_name), JSON.stringify(strategy)],
    );
  }
}

export async function listByAnalysisId(db: Queryable, analysisId: number): Promise<Strategy[]> {
  const result = await db.query(
    `SELECT validated_strategy_json FROM strategy_instances WHERE analysis_id = $1 ORDER BY strategy_instance_id`,
    [analysisId],
  );
  return (result.rows as { validated_strategy_json: Strategy }[]).map((r) => r.validated_strategy_json);
}

export interface StrategyInstanceRow {
  strategyInstanceId: number;
  analysisId: number;
  lessonId: number;
  strategyName: string;
  normalizedName: string;
  strategy: Strategy;
}

/** Fetches full instance records (not just the JSON) for course synthesis (Phase 3.4) — see synthesis/normalize.ts's StrategyInstanceRecord, which this maps onto once a lessonTitle is merged in by the caller. */
export async function listInstancesByAnalysisIds(db: Queryable, analysisIds: number[]): Promise<StrategyInstanceRow[]> {
  if (analysisIds.length === 0) return [];
  const result = await db.query(
    `SELECT strategy_instance_id, analysis_id, lesson_id, strategy_name, normalized_name, validated_strategy_json
     FROM strategy_instances WHERE analysis_id = ANY($1::bigint[]) ORDER BY strategy_instance_id`,
    [analysisIds],
  );
  return (
    result.rows as {
      strategy_instance_id: string;
      analysis_id: string;
      lesson_id: string;
      strategy_name: string;
      normalized_name: string;
      validated_strategy_json: Strategy;
    }[]
  ).map((r) => ({
    strategyInstanceId: Number(r.strategy_instance_id),
    analysisId: Number(r.analysis_id),
    lessonId: Number(r.lesson_id),
    strategyName: r.strategy_name,
    normalizedName: r.normalized_name,
    strategy: r.validated_strategy_json,
  }));
}
