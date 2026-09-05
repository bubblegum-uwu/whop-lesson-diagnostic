import type { Pool } from "pg";
import { upsertCourse } from "../db/coursesRepo.js";
import { syncLessons, type SyncLessonInput } from "../db/lessonsRepo.js";
import { fetchAllCourseLessons, type WhopCourseClient } from "../whop/courseClient.js";
import { buildLessonSourceUrl } from "../whop/lessonUrl.js";
import type { WhopCourseResponse, WhopCourseLessonListItem } from "../whop/types.js";

export interface CourseSyncConfig {
  courseId: string;
  experienceId: string;
  slug: string;
}

export interface CourseSyncResult {
  courseTitle: string;
  upserted: number;
  archived: number;
}

interface ChapterRef {
  chapterWhopId: string;
  chapterTitle: string;
  chapterOrder: number;
}

/** `GET /courses/{id}` is used only for this join — never as the lesson inventory itself. */
function buildChapterLookup(course: WhopCourseResponse): Map<string, ChapterRef> {
  const lookup = new Map<string, ChapterRef>();
  for (const chapter of course.chapters) {
    for (const lessonRef of chapter.lessons) {
      lookup.set(lessonRef.id, {
        chapterWhopId: chapter.id,
        chapterTitle: chapter.title,
        chapterOrder: chapter.order,
      });
    }
  }
  return lookup;
}

function toSyncInput(
  lesson: WhopCourseLessonListItem,
  chapterLookup: Map<string, ChapterRef>,
  config: CourseSyncConfig,
): SyncLessonInput {
  const chapter = chapterLookup.get(lesson.id);
  return {
    whopLessonId: lesson.id,
    title: lesson.title,
    lessonType: lesson.lesson_type,
    visibility: lesson.visibility,
    chapterWhopId: chapter?.chapterWhopId ?? null,
    chapterTitle: chapter?.chapterTitle ?? null,
    chapterOrder: chapter?.chapterOrder ?? null,
    courseOrder: lesson.order,
    durationSeconds: lesson.video_asset?.duration_seconds ?? null,
    videoAssetStatus: lesson.video_asset?.status ?? null,
    videoAvailable: lesson.video_asset?.status === "ready",
    sourceUrl: buildLessonSourceUrl(config.slug, config.experienceId, config.courseId, lesson.id),
  };
}

/**
 * Discovers the course's chapter hierarchy (`GET /courses/{id}`, metadata +
 * ordering only) and its authoritative, paginated lesson inventory
 * (`GET /course_lessons?course_id=`), joins the two by lesson id, and
 * persists the result. Never touches any analysis history — only
 * `courses`/`lessons` metadata.
 */
export async function syncCourse(
  pool: Pool,
  courseClient: WhopCourseClient,
  accessToken: string,
  config: CourseSyncConfig,
): Promise<CourseSyncResult> {
  const [course, lessons] = await Promise.all([
    courseClient.fetchCourse(config.courseId, accessToken),
    fetchAllCourseLessons(courseClient, config.courseId, accessToken),
  ]);

  const chapterLookup = buildChapterLookup(course);
  const syncInputs = lessons.map((lesson) => toSyncInput(lesson, chapterLookup, config));

  const courseRow = await upsertCourse(pool, {
    whopCourseId: config.courseId,
    whopExperienceId: config.experienceId,
    slug: config.slug,
    title: course.title,
  });

  const { upserted, archived } = await syncLessons(pool, courseRow.id, syncInputs);
  return { courseTitle: course.title, upserted, archived };
}
