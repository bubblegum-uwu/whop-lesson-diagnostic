import type { Pool, PoolClient } from "pg";
import type { CanonicalStrategy } from "../synthesis/schema.js";

export type Queryable = Pool | PoolClient;

export interface CanonicalStrategyRow {
  canonicalStrategyId: number;
  runId: string;
  clusterId: number;
  name: string;
  strategy: CanonicalStrategy;
  createdAt: Date;
}

interface Row {
  canonical_strategy_id: string;
  run_id: string;
  cluster_id: string;
  name: string;
  strategy_json: CanonicalStrategy;
  created_at: Date;
}

function mapRow(row: Row): CanonicalStrategyRow {
  return {
    canonicalStrategyId: Number(row.canonical_strategy_id),
    runId: row.run_id,
    clusterId: Number(row.cluster_id),
    name: row.name,
    strategy: row.strategy_json,
    createdAt: row.created_at,
  };
}

const COLUMNS = `canonical_strategy_id, run_id, cluster_id, name, strategy_json, created_at`;

export async function createCanonicalStrategy(
  db: Queryable,
  runId: string,
  clusterId: number,
  strategy: CanonicalStrategy,
): Promise<CanonicalStrategyRow> {
  const result = await db.query(
    `INSERT INTO canonical_strategies (run_id, cluster_id, name, strategy_json)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [runId, clusterId, strategy.name, JSON.stringify(strategy)],
  );
  return mapRow(result.rows[0] as Row);
}

export async function listCanonicalStrategiesByRun(db: Queryable, runId: string): Promise<CanonicalStrategyRow[]> {
  const result = await db.query(`SELECT ${COLUMNS} FROM canonical_strategies WHERE run_id = $1 ORDER BY canonical_strategy_id`, [runId]);
  return (result.rows as Row[]).map(mapRow);
}
