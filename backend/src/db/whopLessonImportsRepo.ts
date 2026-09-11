import type { Pool } from "pg";

/**
 * Phase 4K follow-up — see the
 * 1789900000000_whop-ala-carte-lessons.sql migration's doc comment. A row
 * here means "this lesson is visible in `projectId`'s catalog because it
 * was explicitly imported à-la-carte" — separate from, and not implied
 * by, `courses.project_id` (full course connection).
 */
export interface WhopLessonImportRow {
  lessonId: number;
  projectId: number;
  createdAt: Date;
}

function mapRow(row: { lesson_id: string; project_id: string; created_at: Date }): WhopLessonImportRow {
  return { lessonId: Number(row.lesson_id), projectId: Number(row.project_id), createdAt: row.created_at };
}

/**
 * Race-safe, same ON CONFLICT DO NOTHING + follow-up SELECT convention as
 * projectSourcesRepo.createDiscordSource / sourceCollectionsRepo.createSourceCollection.
 * `lesson_id` is the table's PRIMARY KEY (see the migration), so a
 * conflict means this lesson is ALREADY à-la-carted — by this project
 * (the caller should treat that as "duplicate") or by a different one
 * (the caller should reject it, mirroring the existing
 * course-already-connected-to-a-different-project check). Either way this
 * function itself just reports created:false and returns whichever row
 * actually exists — the caller (http/routes/whopLessons.ts) decides what
 * that means.
 */
export async function createWhopLessonImport(pool: Pool, projectId: number, lessonId: number): Promise<{ importRow: WhopLessonImportRow; created: boolean }> {
  const inserted = await pool.query<{ lesson_id: string; project_id: string; created_at: Date }>(
    `INSERT INTO project_whop_lesson_imports (lesson_id, project_id) VALUES ($1, $2)
     ON CONFLICT (lesson_id) DO NOTHING
     RETURNING lesson_id, project_id, created_at`,
    [lessonId, projectId],
  );
  if (inserted.rows[0]) {
    return { importRow: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<{ lesson_id: string; project_id: string; created_at: Date }>(
    `SELECT lesson_id, project_id, created_at FROM project_whop_lesson_imports WHERE lesson_id = $1`,
    [lessonId],
  );
  return { importRow: mapRow(existing.rows[0]), created: false };
}

export async function getWhopLessonImportByLessonId(pool: Pool, lessonId: number): Promise<WhopLessonImportRow | null> {
  const result = await pool.query<{ lesson_id: string; project_id: string; created_at: Date }>(
    `SELECT lesson_id, project_id, created_at FROM project_whop_lesson_imports WHERE lesson_id = $1`,
    [lessonId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * Every lesson_id, among the given candidates, that is ALREADY à-la-carted
 * by a DIFFERENT project than `projectId` — used to refuse connecting a
 * full course when one of its lessons was already claimed à-la-carte by
 * someone else (spec: "a project cannot accidentally inherit another
 * project's Whop catalog membership" — this is the reverse-direction
 * guard, full-course-connect stealing an already-à-la-carted lesson).
 */
export async function getWhopLessonImportsOwnedByOtherProject(pool: Pool, lessonIds: number[], projectId: number): Promise<WhopLessonImportRow[]> {
  if (lessonIds.length === 0) return [];
  const result = await pool.query<{ lesson_id: string; project_id: string; created_at: Date }>(
    `SELECT lesson_id, project_id, created_at FROM project_whop_lesson_imports WHERE lesson_id = ANY($1) AND project_id != $2`,
    [lessonIds, projectId],
  );
  return result.rows.map(mapRow);
}

export interface WhopAlaCarteLessonRow {
  lessonId: number;
  title: string;
  sourceUrl: string;
  durationSeconds: number | null;
  courseId: number;
  courseTitle: string;
  createdAt: Date;
}

/**
 * This project's à-la-carte Whop lessons, EXCLUDING any whose course has
 * since become fully connected to this SAME project — those are already
 * shown via the "Connected Courses" listing (GET /whop-courses/:id/lessons)
 * and must not also appear in the flat à-la-carte list (spec section 4/7:
 * one catalog item, never a duplicate presentation of it). A lesson
 * à-la-carted by this project whose course got connected to a DIFFERENT
 * project can't happen — createConnectWhopCourseHandler refuses that (see
 * getWhopLessonImportsOwnedByOtherProject above).
 */
export async function listAlaCarteWhopLessonsByProjectId(pool: Pool, projectId: number): Promise<WhopAlaCarteLessonRow[]> {
  const result = await pool.query<{
    lesson_id: string;
    title: string;
    source_url: string;
    duration_seconds: number | null;
    course_id: string;
    course_title: string;
    created_at: Date;
  }>(
    `SELECT pwli.lesson_id, l.title, l.source_url, l.duration_seconds, c.id AS course_id, c.title AS course_title, pwli.created_at
     FROM project_whop_lesson_imports pwli
     JOIN lessons l ON l.id = pwli.lesson_id
     JOIN courses c ON c.id = l.course_id
     WHERE pwli.project_id = $1 AND (c.project_id IS NULL OR c.project_id != $1)
     ORDER BY pwli.created_at ASC`,
    [projectId],
  );
  return result.rows.map((row) => ({
    lessonId: Number(row.lesson_id),
    title: row.title,
    sourceUrl: row.source_url,
    durationSeconds: row.duration_seconds,
    courseId: Number(row.course_id),
    courseTitle: row.course_title,
    createdAt: row.created_at,
  }));
}
