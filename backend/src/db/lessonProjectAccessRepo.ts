import type { Pool } from "pg";

/**
 * Pre-4M — the ONE "does this Whop lesson belong to this project" rule,
 * shared by the synthesis_set_lessons membership routes and the legacy
 * recovery script. This is NOT a new ownership rule: it replicates the
 * exact OR-condition already enforced independently in
 * http/routes/whopCourses.ts (course-connect) and
 * http/routes/whopLessons.ts (à-la-carte import) —
 *
 *   lesson belongs to project P  iff
 *     lesson.course.project_id = P                              (fully-connected course)
 *     OR EXISTS (SELECT 1 FROM project_whop_lesson_imports        (à-la-carte import)
 *                WHERE lesson_id = lesson.id AND project_id = P)
 *
 * `lessons` itself carries no `project_id` column (see
 * 1789900000000_whop-ala-carte-lessons.sql's own doc comment), so this
 * cannot be expressed as a single database foreign key the way
 * synthesis_set_sources enforces project_source ownership — this function
 * is the application-layer equivalent, always run BEFORE any
 * synthesis_set_lessons insert (see synthesisSetLessonsRepo.ts /
 * http/routes/synthesisSets.ts).
 */
export async function getLessonIdsOwnedByProject(pool: Pool, lessonIds: number[], projectId: number): Promise<Set<number>> {
  if (lessonIds.length === 0) return new Set();
  const result = await pool.query<{ lesson_id: string }>(
    `SELECT l.id AS lesson_id
     FROM lessons l
     JOIN courses c ON c.id = l.course_id
     WHERE l.id = ANY($1::bigint[]) AND c.project_id = $2
     UNION
     SELECT pwli.lesson_id
     FROM project_whop_lesson_imports pwli
     WHERE pwli.lesson_id = ANY($1::bigint[]) AND pwli.project_id = $2`,
    [lessonIds, projectId],
  );
  return new Set(result.rows.map((r) => Number(r.lesson_id)));
}

export async function isLessonOwnedByProject(pool: Pool, lessonId: number, projectId: number): Promise<boolean> {
  const owned = await getLessonIdsOwnedByProject(pool, [lessonId], projectId);
  return owned.has(lessonId);
}
