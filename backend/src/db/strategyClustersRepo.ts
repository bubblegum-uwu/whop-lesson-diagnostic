import type { Pool, PoolClient } from "pg";
import type { ClusterProposal } from "../synthesis/schema.js";

export type Queryable = Pool | PoolClient;

export interface StrategyClusterRow {
  clusterId: number;
  runId: string;
  clusterKey: string;
  canonicalName: string;
  cluster: ClusterProposal;
  createdAt: Date;
}

interface Row {
  cluster_id: string;
  run_id: string;
  cluster_key: string;
  canonical_name: string;
  cluster_json: ClusterProposal;
  created_at: Date;
}

function mapRow(row: Row): StrategyClusterRow {
  return {
    clusterId: Number(row.cluster_id),
    runId: row.run_id,
    clusterKey: row.cluster_key,
    canonicalName: row.canonical_name,
    cluster: row.cluster_json,
    createdAt: row.created_at,
  };
}

const COLUMNS = `cluster_id, run_id, cluster_key, canonical_name, cluster_json, created_at`;

export async function createStrategyCluster(
  db: Queryable,
  runId: string,
  cluster: ClusterProposal,
): Promise<StrategyClusterRow> {
  const result = await db.query(
    `INSERT INTO strategy_clusters (run_id, cluster_key, canonical_name, cluster_json)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [runId, cluster.clusterKey, cluster.proposedCanonicalName, JSON.stringify(cluster)],
  );
  return mapRow(result.rows[0] as Row);
}

export async function listStrategyClustersByRun(db: Queryable, runId: string): Promise<StrategyClusterRow[]> {
  const result = await db.query(`SELECT ${COLUMNS} FROM strategy_clusters WHERE run_id = $1 ORDER BY cluster_id`, [runId]);
  return (result.rows as Row[]).map(mapRow);
}
