import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getCourseSpendSummary } from "../../db/lessonAnalysesRepo.js";

export interface AnalysisSummaryRouteDeps {
  pool: Pool;
  whopCourseId: string;
}

/**
 * Builds the dashboard-counters `AnalysisSummary` shape for an arbitrary
 * set of lesson ids. Extracted so both the legacy global
 * `/api/analysis/summary` handler below AND the course-scoped
 * `GET /api/projects/:projectId/whop-courses/:courseId/dashboard` handler
 * (http/routes/whopCourses.ts, Phase 4K-D follow-up) share the exact same
 * aggregation — never two independently-maintained copies of this
 * dashboard-stats shape that could silently drift apart. `totalLessons` is
 * passed separately (not re-derived from lessonIds.length here) only so a
 * caller that already has the full lesson count on hand never needs a
 * second array just to re-measure it — every current caller does pass
 * `lessonIds.length` for it regardless.
 */
export async function buildAnalysisSummary(pool: Pool, lessonIds: number[], totalLessons = lessonIds.length) {
  const counts = await getSummaryCounts(pool, lessonIds);
  const spend = await getCourseSpendSummary(pool, lessonIds);

  const analyzed = counts.completed + counts.noStrategy;
  const accountedFor = analyzed + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

  return {
    totalLessons,
    analyzed,
    strategyLessons: counts.completed,
    noStrategy: counts.noStrategy,
    processing: counts.processing,
    queued: counts.queued,
    failed: counts.failed,
    authRequired: counts.authRequired,
    remaining: Math.max(0, totalLessons - accountedFor),
    totalCost: spend.totalCost,
    averageCostPerLesson: spend.averageCostPerLesson,
    averageProcessingSeconds: spend.averageProcessingSeconds,
  };
}

/** GET /api/analysis/summary — the dashboard counters row. Reads Postgres only. */
export function createAnalysisSummaryHandler(deps: AnalysisSummaryRouteDeps) {
  return async function analysisSummaryHandler(_req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(200).json({ summary: null });
      return;
    }
    const lessons = await listLessons(deps.pool, course.id);
    const lessonIds = lessons.map((l) => l.id);
    const summary = await buildAnalysisSummary(deps.pool, lessonIds, lessons.length);

    res.status(200).json({ summary });
  };
}
