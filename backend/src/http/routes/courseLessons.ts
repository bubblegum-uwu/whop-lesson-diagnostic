import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";

export interface CourseLessonsRouteDeps {
  pool: Pool;
  whopCourseId: string;
}

/**
 * GET /api/course/lessons — reads persisted state only (never calls Whop),
 * so the Course table stays usable without a fresh Whop token in hand.
 */
export function createCourseLessonsHandler(deps: CourseLessonsRouteDeps) {
  return async function courseLessonsHandler(_req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(200).json({ course: null, lessons: [] });
      return;
    }

    const lessons = await listLessons(deps.pool, course.id);
    res.status(200).json({
      course: {
        title: course.title,
        slug: course.slug,
        lastSyncedAt: course.lastSyncedAt,
      },
      lessons: lessons.map((l) => ({
        id: l.id,
        title: l.title,
        chapterTitle: l.chapterTitle,
        chapterOrder: l.chapterOrder,
        courseOrder: l.courseOrder,
        durationSeconds: l.durationSeconds,
        videoAvailable: l.videoAvailable,
        sourceUrl: l.sourceUrl,
        lastSyncedAt: l.lastSyncedAt,
      })),
    });
  };
}
