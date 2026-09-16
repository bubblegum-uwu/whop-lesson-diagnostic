import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getLatestJobsByLesson } from "../../db/analysisJobsRepo.js";
import { getLatestByLessons } from "../../db/lessonAnalysesRepo.js";
import { ruleCounts, aggregateConfidence, extractedStrategiesLabel, knowledgeItemCounts, hasSupportingKnowledge } from "../../pipeline/analysisSummary.js";

export interface CourseLessonsRouteDeps {
  pool: Pool;
  whopCourseId: string;
}

/**
 * Builds the rich, per-lesson job+analysis summary array (the
 * `CourseLessonSummary[]` shape the frontend's CourseTable/DashboardSummary
 * consume) for one already-resolved course's internal id. Extracted so
 * BOTH the legacy global `/api/course/lessons` handler below AND the
 * course-scoped `GET /api/projects/:projectId/whop-courses/:courseId/dashboard`
 * handler (http/routes/whopCourses.ts, Phase 4K-D follow-up) share the
 * exact same mapping — never two independently-maintained copies of this
 * job/analysis-summary shape that could silently drift apart.
 */
export async function buildCourseLessonSummaries(pool: Pool, courseId: number) {
  const lessons = await listLessons(pool, courseId);
  const lessonIds = lessons.map((l) => l.id);
  const [jobsByLesson, analysesByLesson] = await Promise.all([
    getLatestJobsByLesson(pool, lessonIds),
    getLatestByLessons(pool, lessonIds),
  ]);

  return lessons.map((l) => {
    const job = jobsByLesson.get(l.id) ?? null;
    const analysis = analysesByLesson.get(l.id) ?? null;

    return {
      id: l.id,
      title: l.title,
      chapterTitle: l.chapterTitle,
      chapterOrder: l.chapterOrder,
      courseOrder: l.courseOrder,
      durationSeconds: l.durationSeconds,
      videoAvailable: l.videoAvailable,
      sourceUrl: l.sourceUrl,
      lastSyncedAt: l.lastSyncedAt,
      job: job
        ? {
            jobId: job.jobId,
            status: job.status,
            currentStage: job.currentStage,
            stageProgress: job.stageProgress,
            overallProgress: job.overallProgress,
            lastHeartbeatAt: job.lastHeartbeatAt,
            leaseExpiresAt: job.leaseExpiresAt,
            attemptCount: job.attemptCount,
            sanitizedError: job.sanitizedError,
            errorType: job.errorType,
          }
        : { jobId: null, status: "NOT_ANALYZED" as const },
      analysis: analysis
        ? {
            analysisId: analysis.analysisId,
            strategyFound: analysis.strategyFound,
            extractedStrategiesLabel: extractedStrategiesLabel(analysis.validatedJson),
            ruleCounts: ruleCounts(analysis.validatedJson),
            confidence: aggregateConfidence(analysis.validatedJson),
            summary: analysis.analysisSummary,
            // Phase 3.5: a lesson can have strategyFound=false while still
            // carrying real supporting knowledge (risk management, sizing,
            // psychology, ...) — this lets the Course table show that
            // distinctly from a lesson with genuinely nothing extracted,
            // without the frontend having to re-derive it from raw counts.
            hasSupportingKnowledge: hasSupportingKnowledge(analysis.validatedJson),
            knowledgeItemCounts: knowledgeItemCounts(analysis.validatedJson),
            schemaVersion: analysis.schemaVersion,
            estimatedCost: analysis.estimatedCost,
            processingDurationSeconds: analysis.processingDurationSeconds,
            completedAt: analysis.completedAt,
          }
        : null,
    };
  });
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

    const lessons = await buildCourseLessonSummaries(deps.pool, course.id);

    res.status(200).json({
      course: {
        title: course.title,
        slug: course.slug,
        lastSyncedAt: course.lastSyncedAt,
      },
      lessons,
    });
  };
}
