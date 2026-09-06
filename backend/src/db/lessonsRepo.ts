import type { Pool, PoolClient } from "pg";

export interface LessonRow {
  id: number;
  courseId: number;
  whopLessonId: string;
  title: string;
  lessonType: string;
  visibility: string | null;
  chapterWhopId: string | null;
  chapterTitle: string | null;
  chapterOrder: number | null;
  courseOrder: number | null;
  durationSeconds: number | null;
  videoAssetStatus: string | null;
  videoAvailable: boolean;
  sourceUrl: string;
  archivedAt: Date | null;
  lastSyncedAt: Date;
}

export interface SyncLessonInput {
  whopLessonId: string;
  title: string;
  lessonType: string;
  visibility: string | null;
  chapterWhopId: string | null;
  chapterTitle: string | null;
  chapterOrder: number | null;
  courseOrder: number | null;
  durationSeconds: number | null;
  videoAssetStatus: string | null;
  videoAvailable: boolean;
  sourceUrl: string;
}

function mapRow(row: {
  id: string;
  course_id: string;
  whop_lesson_id: string;
  title: string;
  lesson_type: string;
  visibility: string | null;
  chapter_whop_id: string | null;
  chapter_title: string | null;
  chapter_order: number | null;
  course_order: number | null;
  duration_seconds: number | null;
  video_asset_status: string | null;
  video_available: boolean;
  source_url: string;
  archived_at: Date | null;
  last_synced_at: Date;
}): LessonRow {
  return {
    id: Number(row.id),
    courseId: Number(row.course_id),
    whopLessonId: row.whop_lesson_id,
    title: row.title,
    lessonType: row.lesson_type,
    visibility: row.visibility,
    chapterWhopId: row.chapter_whop_id,
    chapterTitle: row.chapter_title,
    chapterOrder: row.chapter_order,
    courseOrder: row.course_order,
    durationSeconds: row.duration_seconds,
    videoAssetStatus: row.video_asset_status,
    videoAvailable: row.video_available,
    sourceUrl: row.source_url,
    archivedAt: row.archived_at,
    lastSyncedAt: row.last_synced_at,
  };
}

async function upsertOne(
  client: PoolClient,
  courseId: number,
  lesson: SyncLessonInput,
): Promise<void> {
  await client.query(
    `INSERT INTO lessons (
       course_id, whop_lesson_id, title, lesson_type, visibility,
       chapter_whop_id, chapter_title, chapter_order, course_order,
       duration_seconds, video_asset_status, video_available, source_url,
       archived_at, last_synced_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, now())
     ON CONFLICT (course_id, whop_lesson_id) DO UPDATE SET
       title = EXCLUDED.title,
       lesson_type = EXCLUDED.lesson_type,
       visibility = EXCLUDED.visibility,
       chapter_whop_id = EXCLUDED.chapter_whop_id,
       chapter_title = EXCLUDED.chapter_title,
       chapter_order = EXCLUDED.chapter_order,
       course_order = EXCLUDED.course_order,
       duration_seconds = EXCLUDED.duration_seconds,
       video_asset_status = EXCLUDED.video_asset_status,
       video_available = EXCLUDED.video_available,
       source_url = EXCLUDED.source_url,
       archived_at = NULL,
       updated_at = now(),
       last_synced_at = now()`,
    [
      courseId,
      lesson.whopLessonId,
      lesson.title,
      lesson.lessonType,
      lesson.visibility,
      lesson.chapterWhopId,
      lesson.chapterTitle,
      lesson.chapterOrder,
      lesson.courseOrder,
      lesson.durationSeconds,
      lesson.videoAssetStatus,
      lesson.videoAvailable,
      lesson.sourceUrl,
    ],
  );
}

/**
 * Upserts every lesson currently seen from Whop, then soft-archives (never
 * deletes) any previously-synced lesson for this course that's no longer
 * present — preserving whatever analysis history it may have.
 */
export async function syncLessons(
  pool: Pool,
  courseId: number,
  lessons: SyncLessonInput[],
): Promise<{ upserted: number; archived: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const lesson of lessons) {
      await upsertOne(client, courseId, lesson);
    }
    const seenIds = lessons.map((l) => l.whopLessonId);
    const archivedResult = await client.query(
      `UPDATE lessons SET archived_at = now(), updated_at = now()
       WHERE course_id = $1 AND archived_at IS NULL AND NOT (whop_lesson_id = ANY($2::text[]))`,
      [courseId, seenIds],
    );
    await client.query("COMMIT");
    return { upserted: lessons.length, archived: archivedResult.rowCount ?? 0 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Non-archived lessons for a course, ordered the way the course is actually taught. */
export async function listLessons(pool: Pool, courseId: number): Promise<LessonRow[]> {
  const result = await pool.query(
    `SELECT id, course_id, whop_lesson_id, title, lesson_type, visibility,
            chapter_whop_id, chapter_title, chapter_order, course_order,
            duration_seconds, video_asset_status, video_available, source_url,
            archived_at, last_synced_at
     FROM lessons
     WHERE course_id = $1 AND archived_at IS NULL
     ORDER BY chapter_order NULLS LAST, course_order NULLS LAST, id`,
    [courseId],
  );
  return result.rows.map(mapRow);
}

export async function getLessonById(pool: Pool, lessonId: number): Promise<LessonRow | null> {
  const result = await pool.query(
    `SELECT id, course_id, whop_lesson_id, title, lesson_type, visibility,
            chapter_whop_id, chapter_title, chapter_order, course_order,
            duration_seconds, video_asset_status, video_available, source_url,
            archived_at, last_synced_at
     FROM lessons WHERE id = $1`,
    [lessonId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getLessonsByIds(pool: Pool, lessonIds: number[]): Promise<LessonRow[]> {
  if (lessonIds.length === 0) return [];
  const result = await pool.query(
    `SELECT id, course_id, whop_lesson_id, title, lesson_type, visibility,
            chapter_whop_id, chapter_title, chapter_order, course_order,
            duration_seconds, video_asset_status, video_available, source_url,
            archived_at, last_synced_at
     FROM lessons WHERE id = ANY($1::bigint[])`,
    [lessonIds],
  );
  return result.rows.map(mapRow);
}

/** Backfills a duration Whop didn't report at sync time (see pipeline's onDurationDiscovered). Never overwrites a value with null. */
export async function updateDurationSeconds(pool: Pool, lessonId: number, durationSeconds: number): Promise<void> {
  await pool.query(
    `UPDATE lessons SET duration_seconds = $2, updated_at = now() WHERE id = $1`,
    [lessonId, durationSeconds],
  );
}
