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
    const counts = await getSummaryCounts(deps.pool, lessonIds);
    const spend = await getCourseSpendSummary(deps.pool, lessonIds);

    const analyzed = counts.completed + counts.noStrategy;
    const accountedFor = analyzed + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

    res.status(200).json({
      summary: {
        totalLessons: lessons.length,
        analyzed,
        strategyLessons: counts.completed,
        noStrategy: counts.noStrategy,
        processing: counts.processing,
        queued: counts.queued,
        failed: counts.failed,
        authRequired: counts.authRequired,
        remaining: Math.max(0, lessons.length - accountedFor),
        totalCost: spend.totalCost,
        averageCostPerLesson: spend.averageCostPerLesson,
        averageProcessingSeconds: spend.averageProcessingSeconds,
      },
    });
  };
}
