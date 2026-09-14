import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

/**
 * Pre-4M — the many-to-many join between synthesis_sets and Whop
 * `lessons`, the parallel-table extension synthesis_set_sources's own
 * migration comment anticipated (see 1790300000000_whop-synthesis-set-bridge.sql).
 * Mirrors synthesisSetSourcesRepo.ts's shape/conventions exactly (idempotent
 * ON CONFLICT DO NOTHING adds, plain membership deletes, batched readiness)
 * so the two membership kinds behave identically from the API layer down —
 * only the underlying table/eligibility-source differs.
 *
 * Deliberately a pure membership table — adding/removing a row here NEVER
 * touches lessons, analysis_jobs, or lesson_analyses.
 */
export interface SynthesisSetLessonMembershipRow {
  synthesisSetId: number;
  lessonId: number;
  projectId: number;
  createdAt: Date;
}

interface MembershipDbRow {
  synthesis_set_id: string;
  lesson_id: string;
  project_id: string;
  created_at: Date;
}

function mapRow(row: MembershipDbRow): SynthesisSetLessonMembershipRow {
  return {
    synthesisSetId: Number(row.synthesis_set_id),
    lessonId: Number(row.lesson_id),
    projectId: Number(row.project_id),
    createdAt: row.created_at,
  };
}

/**
 * `projectId` MUST be the project both the set and the lesson already
 * belong to — callers MUST have already verified lesson ownership via
 * lessonProjectAccessRepo.getLessonIdsOwnedByProject before calling this
 * (see http/routes/synthesisSets.ts), exactly mirroring
 * synthesisSetSourcesRepo.addSourceToSynthesisSet's own documented
 * precondition. Unlike that function, there is no database-level composite
 * FK fallback here (lessons has no project_id column — see the migration's
 * doc comment), so this application-level check is the ONLY guard; skipping
 * it is a real cross-project leak, not just a worse error message.
 */
export async function addLessonToSynthesisSet(
  pool: Pool,
  synthesisSetId: number,
  lessonId: number,
  projectId: number,
): Promise<{ membership: SynthesisSetLessonMembershipRow; created: boolean }> {
  const inserted = await pool.query<MembershipDbRow>(
    `INSERT INTO synthesis_set_lessons (synthesis_set_id, lesson_id, project_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (synthesis_set_id, lesson_id) DO NOTHING
     RETURNING synthesis_set_id, lesson_id, project_id, created_at`,
    [synthesisSetId, lessonId, projectId],
  );
  if (inserted.rows[0]) {
    return { membership: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<MembershipDbRow>(
    `SELECT synthesis_set_id, lesson_id, project_id, created_at FROM synthesis_set_lessons WHERE synthesis_set_id = $1 AND lesson_id = $2`,
    [synthesisSetId, lessonId],
  );
  return { membership: mapRow(existing.rows[0]), created: false };
}

/** Removes membership only — never the lesson itself, never its analysis. Returns true if a row was actually removed. */
export async function removeLessonFromSynthesisSet(pool: Pool, synthesisSetId: number, lessonId: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM synthesis_set_lessons WHERE synthesis_set_id = $1 AND lesson_id = $2`, [synthesisSetId, lessonId]);
  return (result.rowCount ?? 0) > 0;
}

/** Every lesson_id currently a member of this set — used to build the detail view's lesson list. */
export async function listLessonIdsForSynthesisSet(pool: Pool, synthesisSetId: number): Promise<number[]> {
  const result = await pool.query<{ lesson_id: string }>(
    `SELECT lesson_id FROM synthesis_set_lessons WHERE synthesis_set_id = $1 ORDER BY created_at ASC`,
    [synthesisSetId],
  );
  return result.rows.map((r) => Number(r.lesson_id));
}

/**
 * Bulk membership insert for an explicit, already-validated (ownership AND
 * eligibility) list of lesson ids — the caller (http/routes/synthesisSets.ts)
 * is responsible for that, exactly mirroring
 * synthesisSetSourcesRepo.bulkAddSourcesToSynthesisSet.
 */
export async function bulkAddLessonsToSynthesisSet(
  db: Queryable,
  synthesisSetId: number,
  projectId: number,
  lessonIds: number[],
): Promise<{ addedCount: number }> {
  if (lessonIds.length === 0) return { addedCount: 0 };
  const result = await db.query(
    `INSERT INTO synthesis_set_lessons (synthesis_set_id, lesson_id, project_id)
     SELECT $1, unnest($2::bigint[]), $3
     ON CONFLICT (synthesis_set_id, lesson_id) DO NOTHING`,
    [synthesisSetId, lessonIds, projectId],
  );
  return { addedCount: result.rowCount ?? 0 };
}

/** Bulk membership removal for an explicit list of lesson ids — never the lesson itself, never its analysis, never any other set. */
export async function bulkRemoveLessonsFromSynthesisSet(pool: Pool, synthesisSetId: number, lessonIds: number[]): Promise<{ removedCount: number }> {
  if (lessonIds.length === 0) return { removedCount: 0 };
  const result = await pool.query(`DELETE FROM synthesis_set_lessons WHERE synthesis_set_id = $1 AND lesson_id = ANY($2::bigint[])`, [synthesisSetId, lessonIds]);
  return { removedCount: result.rowCount ?? 0 };
}

/** Of this set's CURRENT lesson members, which belong to `courseId` — used to bulk-remove "this course's selected lessons" without touching lessons this set selected individually (e.g. à-la-carte) from elsewhere. */
export async function listSynthesisSetLessonIdsForCourse(pool: Pool, synthesisSetId: number, courseId: number): Promise<number[]> {
  const result = await pool.query<{ lesson_id: string }>(
    `SELECT ssl.lesson_id FROM synthesis_set_lessons ssl
     JOIN lessons l ON l.id = ssl.lesson_id
     WHERE ssl.synthesis_set_id = $1 AND l.course_id = $2`,
    [synthesisSetId, courseId],
  );
  return result.rows.map((r) => Number(r.lesson_id));
}

export interface SynthesisSetLessonReadiness {
  lessonCount: number;
  analyzedLessonCount: number;
  needsAnalysisCount: number;
}

/**
 * Pre-4M — the lesson-membership sibling of
 * synthesisSetSourcesRepo.getSynthesisSetReadiness, same "derived, never
 * persisted" nature. "Analyzed" means this lesson currently has at least
 * one completed/no_strategy lesson_analyses row — the exact same
 * eligibility vocabulary whopLessonAnalysisStatusRepo.ts already uses for
 * Whop Course/à-la-carte listings (never a different/stricter rule). Pure
 * read — never enqueues, triggers, or modifies analysis.
 */
export async function getSynthesisSetLessonReadiness(pool: Pool, synthesisSetId: number): Promise<SynthesisSetLessonReadiness> {
  const result = await pool.query<{ lesson_count: string; analyzed_count: string }>(
    `SELECT
       COUNT(*) AS lesson_count,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM lesson_analyses la
           WHERE la.lesson_id = ssl.lesson_id AND la.status IN ('completed', 'no_strategy')
         )
       ) AS analyzed_count
     FROM synthesis_set_lessons ssl
     WHERE ssl.synthesis_set_id = $1`,
    [synthesisSetId],
  );
  const lessonCount = Number(result.rows[0]?.lesson_count ?? 0);
  const analyzedLessonCount = Number(result.rows[0]?.analyzed_count ?? 0);
  return { lessonCount, analyzedLessonCount, needsAnalysisCount: lessonCount - analyzedLessonCount };
}

/** Readiness for every set in a project, in one query — the batched sibling used by the list endpoint, avoiding an N+1 across sets. A set with zero lesson members simply has no entry in the returned map. */
export async function getLessonReadinessBySynthesisSetId(pool: Pool, synthesisSetIds: number[]): Promise<Map<number, SynthesisSetLessonReadiness>> {
  if (synthesisSetIds.length === 0) return new Map();
  const result = await pool.query<{ synthesis_set_id: string; lesson_count: string; analyzed_count: string }>(
    `SELECT
       ssl.synthesis_set_id AS synthesis_set_id,
       COUNT(*) AS lesson_count,
       COUNT(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM lesson_analyses la
           WHERE la.lesson_id = ssl.lesson_id AND la.status IN ('completed', 'no_strategy')
         )
       ) AS analyzed_count
     FROM synthesis_set_lessons ssl
     WHERE ssl.synthesis_set_id = ANY($1)
     GROUP BY ssl.synthesis_set_id`,
    [synthesisSetIds],
  );
  return new Map(
    result.rows.map((r) => {
      const lessonCount = Number(r.lesson_count);
      const analyzedLessonCount = Number(r.analyzed_count);
      return [Number(r.synthesis_set_id), { lessonCount, analyzedLessonCount, needsAnalysisCount: lessonCount - analyzedLessonCount }];
    }),
  );
}
