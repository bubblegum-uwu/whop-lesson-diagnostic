import type { Pool } from "pg";

/**
 * Batched (never N+1 — spec section 46/63 precedent, same shape as
 * projectSourceCatalogStatusRepo.ts) status lookup for an arbitrary set of
 * Whop lesson ids, shared by the full-course lesson listing
 * (http/routes/whopCourses.ts) and the à-la-carte lesson listing
 * (http/routes/whopLessons.ts) — exactly two queries regardless of how
 * many lesson ids are passed.
 */
export type WhopLessonAnalysisStatus = "NOT_ANALYZED" | "ANALYZED" | string;

export interface WhopLessonAnalysisStatusEntry {
  status: WhopLessonAnalysisStatus;
  eligibleForSynthesis: boolean;
}

export async function getWhopLessonAnalysisStatus(pool: Pool, lessonIds: number[]): Promise<Map<number, WhopLessonAnalysisStatusEntry>> {
  const result = new Map<number, WhopLessonAnalysisStatusEntry>();
  if (lessonIds.length === 0) return result;

  const analyzedResult = await pool.query<{ lesson_id: string }>(
    `SELECT DISTINCT lesson_id FROM lesson_analyses WHERE lesson_id = ANY($1) AND status IN ('completed', 'no_strategy')`,
    [lessonIds],
  );
  const analyzedIds = new Set(analyzedResult.rows.map((r) => Number(r.lesson_id)));

  const latestJobResult = await pool.query<{ lesson_id: string; status: string }>(
    `SELECT DISTINCT ON (lesson_id) lesson_id, status FROM analysis_jobs WHERE lesson_id = ANY($1) ORDER BY lesson_id, created_at DESC`,
    [lessonIds],
  );
  const latestJobByLesson = new Map(latestJobResult.rows.map((r) => [Number(r.lesson_id), r.status]));

  for (const lessonId of lessonIds) {
    const analyzed = analyzedIds.has(lessonId);
    result.set(lessonId, { status: analyzed ? "ANALYZED" : (latestJobByLesson.get(lessonId) ?? "NOT_ANALYZED"), eligibleForSynthesis: analyzed });
  }
  return result;
}
