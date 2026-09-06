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
