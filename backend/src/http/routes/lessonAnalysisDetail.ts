import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getLatestByLesson } from "../../db/lessonAnalysesRepo.js";

export interface LessonAnalysisDetailRouteDeps {
  pool: Pool;
}

/** GET /api/course/lessons/:lessonId/analysis — the full validated JSON for [ View Analysis ] / Download JSON. Reads Postgres only. */
export function createLessonAnalysisDetailHandler(deps: LessonAnalysisDetailRouteDeps) {
  return async function lessonAnalysisDetailHandler(req: Request, res: Response): Promise<void> {
    const lessonId = Number(req.params.lessonId);
    if (!Number.isFinite(lessonId)) {
      res.status(400).json({ error: { message: "Invalid lesson id.", type: "invalid_request" } });
      return;
    }
    const analysis = await getLatestByLesson(deps.pool, lessonId);
    if (!analysis) {
      res.status(404).json({ error: { message: "No analysis found for this lesson.", type: "not_found" } });
      return;
    }
    res.status(200).json({ validatedJson: analysis.validatedJson });
  };
}
