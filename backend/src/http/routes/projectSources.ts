import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getCoursesByProjectId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getCourseSpendSummary } from "../../db/lessonAnalysesRepo.js";

export interface ProjectSourcesRouteDeps {
  pool: Pool;
}

export type SourceProvider = "WHOP";
export type SourceType = "COURSE";

export interface ProjectSource {
  provider: SourceProvider;
  sourceType: SourceType;
  courseId: number;
  externalId: string;
  name: string;
  lessonCount: number;
  analyzedLessonCount: number;
  queuedCount: number;
  processingCount: number;
  failedCount: number;
  remainingCount: number;
  lastSyncedAt: Date | null;
  totalCost: number | null;
}

/**
 * GET /api/projects/:projectId/sources — every real, connected source this
 * project owns. Phase 4C deliberately introduces no `sources` table (see
 * the PR description): a project's only persisted source today is the
 * `courses` row(s) it owns via `courses.project_id`, so this route derives
 * an API-level Source shape from that existing ownership relationship
 * rather than adding speculative schema for YouTube/Discord, which have no
 * connected data to return yet and are never fabricated here.
 *
 * Ownership is enforced by `courses.project_id = :projectId` alone — never
 * by falling back to the deployment's globally configured WHOP_COURSE_ID —
 * so a project with no course legitimately returns `sources: []`.
 */
export function createGetProjectSourcesHandler(deps: ProjectSourcesRouteDeps) {
  return async function getProjectSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const courses = await getCoursesByProjectId(deps.pool, projectId);
    const sources: ProjectSource[] = await Promise.all(
      courses.map(async (course): Promise<ProjectSource> => {
        const lessons = await listLessons(deps.pool, course.id);
        const lessonIds = lessons.map((l) => l.id);
        const [counts, spend] = await Promise.all([
          getSummaryCounts(deps.pool, lessonIds),
          getCourseSpendSummary(deps.pool, lessonIds),
        ]);
        const analyzedLessonCount = counts.completed + counts.noStrategy;
        const accountedFor = analyzedLessonCount + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

        return {
          provider: "WHOP",
          sourceType: "COURSE",
          courseId: course.id,
          externalId: course.whopCourseId,
          name: course.title,
          lessonCount: lessons.length,
          analyzedLessonCount,
          queuedCount: counts.queued,
          processingCount: counts.processing,
          failedCount: counts.failed,
          remainingCount: Math.max(0, lessons.length - accountedFor),
          lastSyncedAt: course.lastSyncedAt,
          totalCost: spend.totalCost,
        };
      }),
    );

    res.status(200).json({ projectId, sources });
  };
}
