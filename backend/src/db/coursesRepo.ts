import type { Pool } from "pg";

export interface CourseRow {
  id: number;
  whopCourseId: string;
  whopExperienceId: string;
  slug: string;
  title: string;
  lastSyncedAt: Date | null;
}

export interface UpsertCourseInput {
  whopCourseId: string;
  whopExperienceId: string;
  slug: string;
  title: string;
}

function mapRow(row: {
  id: string;
  whop_course_id: string;
  whop_experience_id: string;
  slug: string;
  title: string;
  last_synced_at: Date | null;
}): CourseRow {
  return {
    id: Number(row.id),
    whopCourseId: row.whop_course_id,
    whopExperienceId: row.whop_experience_id,
    slug: row.slug,
    title: row.title,
    lastSyncedAt: row.last_synced_at,
  };
}

/** Inserts the course on first sync, or refreshes its metadata and `last_synced_at` on every sync after. */
export async function upsertCourse(pool: Pool, input: UpsertCourseInput): Promise<CourseRow> {
  const result = await pool.query(
    `INSERT INTO courses (whop_course_id, whop_experience_id, slug, title, last_synced_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (whop_course_id) DO UPDATE SET
       whop_experience_id = EXCLUDED.whop_experience_id,
       slug = EXCLUDED.slug,
       title = EXCLUDED.title,
       updated_at = now(),
       last_synced_at = now()
     RETURNING id, whop_course_id, whop_experience_id, slug, title, last_synced_at`,
    [input.whopCourseId, input.whopExperienceId, input.slug, input.title],
  );
  return mapRow(result.rows[0]);
}

export async function getCourseByWhopId(pool: Pool, whopCourseId: string): Promise<CourseRow | null> {
  const result = await pool.query(
    `SELECT id, whop_course_id, whop_experience_id, slug, title, last_synced_at
     FROM courses WHERE whop_course_id = $1`,
    [whopCourseId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
