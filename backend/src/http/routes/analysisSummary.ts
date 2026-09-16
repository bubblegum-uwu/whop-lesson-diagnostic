import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getCourseSpendSummary } from "../../db/lessonAnalysesRepo.js";
import { buildCourseAnalysisSummary } from "../../pipeline/courseDashboard.js";

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

    res.status(200).json({ summary: buildCourseAnalysisSummary(lessons.length, counts, spend) });
  };
}
