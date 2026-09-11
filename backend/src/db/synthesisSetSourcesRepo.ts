import type { Pool } from "pg";

/**
 * Phase 4J — the many-to-many join between synthesis_sets and
 * project_sources. See the 1789700000000_synthesis-sets.sql migration's
 * comment for why this is a plain `project_source_id` FK rather than
 * polymorphic, and why cross-project membership is enforced here in
 * application code rather than by a DB constraint.
 *
 * Deliberately a pure membership table — no status, no ordering, no
 * weighting (Phase 4J explicitly excludes all of that). Adding/removing a
 * row here NEVER touches project_sources, project_source_analysis_jobs, or
 * project_source_analyses — membership is metadata only.
 */
export interface SynthesisSetMembershipRow {
  synthesisSetId: number;
  projectSourceId: number;
  createdAt: Date;
}

interface MembershipDbRow {
  synthesis_set_id: string;
  project_source_id: string;
  created_at: Date;
}

function mapRow(row: MembershipDbRow): SynthesisSetMembershipRow {
  return {
    synthesisSetId: Number(row.synthesis_set_id),
    projectSourceId: Number(row.project_source_id),
    createdAt: row.created_at,
  };
}

/**
 * Race-safe and idempotent (section 11): ON CONFLICT DO NOTHING against
 * the (synthesis_set_id, project_source_id) primary key means adding the
 * same source twice never raises a raw unique-violation and never creates
 * a second row — `created` tells the caller which happened, exactly
 * mirroring projectSourcesRepo.createYouTubeSource's convention.
 *
 * Callers MUST have already verified project_source.project_id ===
 * synthesis_set.project_id themselves before calling this (see
 * http/routes/synthesisSets.ts's resolveOwnedSynthesisSet /
 * resolveOwnedSourceForMembership) — this function does not re-check it,
 * mirroring how projectSourceAnalysisJobsRepo trusts its caller's already
 * -performed ownership resolution.
 */
export async function addSourceToSynthesisSet(
  pool: Pool,
  synthesisSetId: number,
  projectSourceId: number,
): Promise<{ membership: SynthesisSetMembershipRow; created: boolean }> {
  const inserted = await pool.query<MembershipDbRow>(
    `INSERT INTO synthesis_set_sources (synthesis_set_id, project_source_id)
     VALUES ($1, $2)
     ON CONFLICT (synthesis_set_id, project_source_id) DO NOTHING
     RETURNING synthesis_set_id, project_source_id, created_at`,
    [synthesisSetId, projectSourceId],
  );
  if (inserted.rows[0]) {
    return { membership: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<MembershipDbRow>(
    `SELECT synthesis_set_id, project_source_id, created_at FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
    [synthesisSetId, projectSourceId],
  );
  return { membership: mapRow(existing.rows[0]), created: false };
}

/** Removes membership only — never the source itself, never its analysis. Returns true if a row was actually removed. */
export async function removeSourceFromSynthesisSet(pool: Pool, synthesisSetId: number, projectSourceId: number): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
    [synthesisSetId, projectSourceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every project_source_id currently a member of this set — used to build the detail view's source list. */
export async function listProjectSourceIdsForSynthesisSet(pool: Pool, synthesisSetId: number): Promise<number[]> {
  const result = await pool.query<{ project_source_id: string }>(
    `SELECT project_source_id FROM synthesis_set_sources WHERE synthesis_set_id = $1 ORDER BY created_at ASC`,
    [synthesisSetId],
  );
  return result.rows.map((r) => Number(r.project_source_id));
}

/** Every synthesis_set_id this source currently belongs to — the multi-membership lookup (e.g. a future Sources-page "Add to Synthesis" control, or proving one source belongs to several sets). */
export async function listSynthesisSetIdsForSource(pool: Pool, projectSourceId: number): Promise<number[]> {
  const result = await pool.query<{ synthesis_set_id: string }>(
    `SELECT synthesis_set_id FROM synthesis_set_sources WHERE project_source_id = $1 ORDER BY created_at ASC`,
    [projectSourceId],
  );
  return result.rows.map((r) => Number(r.synthesis_set_id));
}

export interface SynthesisSetReadiness {
  sourceCount: number;
  analyzedSourceCount: number;
  needsAnalysisCount: number;
}

/**
 * Phase 4J — a lightweight, DERIVED readiness summary (never persisted,
 * never a stored status — see the migration comment and section 13/14 of
 * the Phase 4J spec). "Analyzed" here means this project_source currently
 * has at least one completed/no_strategy project_source_analyses row —
 * the same "has this source ever been successfully analyzed" signal
 * SourcesPage's own row badge already uses, not a stricter
 * current-fingerprint check (that provenance precision is explicitly
 * Phase 4K's concern, not this one). This NEVER enqueues, triggers, or
 * modifies analysis — pure read.
 */
export async function getSynthesisSetReadiness(pool: Pool, synthesisSetId: number): Promise<SynthesisSetReadiness> {
  const result = await pool.query<{ source_count: string; analyzed_count: string }>(
    `SELECT
       COUNT(*) AS source_count,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM project_source_analyses psa
           WHERE psa.project_source_id = sss.project_source_id AND psa.status IN ('completed', 'no_strategy')
         )
       ) AS analyzed_count
     FROM synthesis_set_sources sss
     WHERE sss.synthesis_set_id = $1`,
    [synthesisSetId],
  );
  const sourceCount = Number(result.rows[0]?.source_count ?? 0);
  const analyzedSourceCount = Number(result.rows[0]?.analyzed_count ?? 0);
  return { sourceCount, analyzedSourceCount, needsAnalysisCount: sourceCount - analyzedSourceCount };
}

/**
 * Readiness for every set in a project, in one query — avoids an N+1 in
 * the list view by computing both member count and analyzed count for
 * every set together.
 */
export async function getReadinessBySynthesisSetId(pool: Pool, synthesisSetIds: number[]): Promise<Map<number, SynthesisSetReadiness>> {
  if (synthesisSetIds.length === 0) return new Map();
  const result = await pool.query<{ synthesis_set_id: string; source_count: string; analyzed_count: string }>(
    `SELECT
       sss.synthesis_set_id AS synthesis_set_id,
       COUNT(*) AS source_count,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM project_source_analyses psa
           WHERE psa.project_source_id = sss.project_source_id AND psa.status IN ('completed', 'no_strategy')
         )
       ) AS analyzed_count
     FROM synthesis_set_sources sss
     WHERE sss.synthesis_set_id = ANY($1)
     GROUP BY sss.synthesis_set_id`,
    [synthesisSetIds],
  );
  return new Map(
    result.rows.map((r) => {
      const sourceCount = Number(r.source_count);
      const analyzedSourceCount = Number(r.analyzed_count);
      return [Number(r.synthesis_set_id), { sourceCount, analyzedSourceCount, needsAnalysisCount: sourceCount - analyzedSourceCount }];
    }),
  );
}
