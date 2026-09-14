import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

/**
 * Pre-4M — a small compatibility relation attaching a historical,
 * course-scoped synthesis_runs row to a Synthesis Set (see
 * 1790300000000_whop-synthesis-set-bridge.sql's doc comment for the full
 * reasoning, especially why `run_id` is this table's PRIMARY KEY: a legacy
 * run attaches to AT MOST ONE recovered Synthesis Set, ever). This table
 * NEVER mutates synthesis_runs or course_playbooks — it only ever
 * references their existing rows read-only.
 */
export interface SynthesisSetLegacyRunAttachmentRow {
  runId: string;
  synthesisSetId: number;
  projectId: number;
  createdAt: Date;
}

interface AttachmentDbRow {
  run_id: string;
  synthesis_set_id: string;
  project_id: string;
  created_at: Date;
}

function mapRow(row: AttachmentDbRow): SynthesisSetLegacyRunAttachmentRow {
  return {
    runId: row.run_id,
    synthesisSetId: Number(row.synthesis_set_id),
    projectId: Number(row.project_id),
    createdAt: row.created_at,
  };
}

/**
 * Idempotent (ON CONFLICT DO NOTHING on the run_id primary key) — attaching
 * the same run to the same set twice is a no-op, never a duplicate row or a
 * raw unique-violation error. Because `run_id` is the primary key (not a
 * composite with synthesis_set_id), attaching a run already attached to a
 * DIFFERENT set returns `created: false` with that OTHER set's attachment
 * row — callers (the recovery script; a future explicit re-attach action)
 * must check `membership.synthesisSetId === synthesisSetId` themselves if
 * they need to distinguish "already attached here" from "attached
 * elsewhere," exactly mirroring how project_whop_lesson_imports callers
 * already handle its lesson_id-primary-key single-owner semantics.
 */
export async function attachLegacyRunToSynthesisSet(
  db: Queryable,
  synthesisSetId: number,
  runId: string,
  projectId: number,
): Promise<{ membership: SynthesisSetLegacyRunAttachmentRow; created: boolean }> {
  const inserted = await db.query<AttachmentDbRow>(
    `INSERT INTO synthesis_set_legacy_runs (run_id, synthesis_set_id, project_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (run_id) DO NOTHING
     RETURNING run_id, synthesis_set_id, project_id, created_at`,
    [runId, synthesisSetId, projectId],
  );
  if (inserted.rows[0]) {
    return { membership: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await db.query<AttachmentDbRow>(
    `SELECT run_id, synthesis_set_id, project_id, created_at FROM synthesis_set_legacy_runs WHERE run_id = $1`,
    [runId],
  );
  return { membership: mapRow(existing.rows[0]), created: false };
}

/** Every run_id currently attached to this set, newest-attached first. */
export async function listLegacyRunIdsForSynthesisSet(pool: Pool, synthesisSetId: number): Promise<string[]> {
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM synthesis_set_legacy_runs WHERE synthesis_set_id = $1 ORDER BY created_at DESC`,
    [synthesisSetId],
  );
  return result.rows.map((r) => r.run_id);
}

/** Which Synthesis Set (if any) a given run is currently attached to — reflects the run_id-primary-key single-owner invariant. */
export async function getLegacyRunAttachment(pool: Pool, runId: string): Promise<SynthesisSetLegacyRunAttachmentRow | null> {
  const result = await pool.query<AttachmentDbRow>(
    `SELECT run_id, synthesis_set_id, project_id, created_at FROM synthesis_set_legacy_runs WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
