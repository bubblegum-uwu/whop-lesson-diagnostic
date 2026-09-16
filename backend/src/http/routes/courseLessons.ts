import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getLatestJobsByLesson } from "../../db/analysisJobsRepo.js";
import { getLatestByLessons } from "../../db/lessonAnalysesRepo.js";
import { buildCourseLessonSummaries } from "../../pipeline/courseDashboard.js";

export interface CourseLessonsRouteDeps {
  pool: Pool;
  whopCourseId: string;
}

/**
 * GET /api/course/lessons — reads persisted state only (never calls Whop),
 * so the Course table stays usable without a fresh Whop token in hand. Since
 * PR2, also joins each lesson's latest analysis job/result so the Course
 * table can render status/progress/output without a second round trip —
 * this is exactly what the frontend uses to reconstruct state after a
 * browser reload or an SSE reconnect, per the "database is the source of
 * truth" requirement.
 */
export function createCourseLessonsHandler(deps: CourseLessonsRouteDeps) {
  return async function courseLessonsHandler(_req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(200).json({ course: null, lessons: [] });
      return;
    }

    const lessons = await listLessons(deps.pool, course.id);
    const lessonIds = lessons.map((l) => l.id);
    const [jobsByLesson, analysesByLesson] = await Promise.all([
      getLatestJobsByLesson(deps.pool, lessonIds),
      getLatestByLessons(deps.pool, lessonIds),
    ]);

    res.status(200).json({
      course: {
        title: course.title,
        slug: course.slug,
        lastSyncedAt: course.lastSyncedAt,
      },
      lessons: buildCourseLessonSummaries(lessons, jobsByLesson, analysesByLesson),
    });
  };
}
