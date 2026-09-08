import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById, type Project } from "../../db/projectsRepo.js";
import { getCoursesByProjectId, type CourseRow } from "../../db/coursesRepo.js";
import { buildSynthesisStatusPayload, buildFullSynthesisPayload, handleSynthesizeForCourse } from "./courseSynthesis.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";

export interface ProjectSynthesisRouteDeps {
  pool: Pool;
  geminiModel: string;
  jobTrigger: JobTrigger;
}

/**
 * Phase 4E — the reasons a project can't resolve to a single usable
 * synthesis source right now. Never a fallback to the deployment's
 * globally configured WHOP_COURSE_ID — a project either owns exactly one
 * course (the only supported shape today) or it doesn't, deterministically:
 *
 * - "unsupported_project_type": GENERAL_KNOWLEDGE has no synthesis engine
 *   yet (Phase 4E does not implement one — see the PR description).
 * - "no_source": the project owns zero courses (see projectSources.ts —
 *   ownership is `courses.project_id`, nothing is fabricated).
 * - "multiple_sources": the project owns more than one course. Arbitrary
 *   multi-source synthesis is deliberately deferred to a later phase;
 *   silently picking one would be a worse failure mode than refusing.
 */
export type ProjectSynthesisUnsupportedReason = "unsupported_project_type" | "no_source" | "multiple_sources";

type ProjectSynthesisResolution =
  | { kind: "not_found" }
  | { kind: ProjectSynthesisUnsupportedReason; project: Project; sourceCount: number }
  | { kind: "ready"; project: Project; course: CourseRow };

async function resolveProjectSynthesisSource(pool: Pool, projectId: number): Promise<ProjectSynthesisResolution> {
  const project = await getProjectById(pool, projectId);
  if (!project) return { kind: "not_found" };
  if (project.projectType !== "TRADING_STRATEGIES") return { kind: "unsupported_project_type", project, sourceCount: 0 };

  const courses = await getCoursesByProjectId(pool, projectId);
  if (courses.length === 0) return { kind: "no_source", project, sourceCount: 0 };
  if (courses.length > 1) return { kind: "multiple_sources", project, sourceCount: courses.length };
  return { kind: "ready", project, course: courses[0] };
}

function parseProjectId(req: Request): number | null {
  const projectId = Number(req.params.projectId);
  return Number.isInteger(projectId) ? projectId : null;
}

function projectNotFound(res: Response): void {
  res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
}

const UNSUPPORTED_MESSAGES: Record<ProjectSynthesisUnsupportedReason, string> = {
  unsupported_project_type: "General Knowledge synthesis is not available yet.",
  no_source: "This project has no connected source yet. Add a source and analyze its content before synthesizing.",
  multiple_sources: "This project has multiple sources — source selection isn't supported yet.",
};

/**
 * GET /api/projects/:projectId/synthesis/status — the project-aware
 * counterpart to GET /api/course/synthesis-status. Resolves the project's
 * course via `courses.project_id` (see resolveProjectSynthesisSource)
 * rather than the globally configured course, then delegates to the exact
 * same `buildSynthesisStatusPayload` the legacy handler uses. Requires only
 * Knovera auth — never Whop — since this reads persisted data.
 */
export function createProjectSynthesisStatusHandler(deps: ProjectSynthesisRouteDeps) {
  return async function projectSynthesisStatusHandler(req: Request, res: Response): Promise<void> {
    const projectId = parseProjectId(req);
    if (projectId === null) {
      projectNotFound(res);
      return;
    }

    const resolution = await resolveProjectSynthesisSource(deps.pool, projectId);
    if (resolution.kind === "not_found") {
      projectNotFound(res);
      return;
    }

    const base = { projectId, projectType: resolution.project.projectType };
    if (resolution.kind !== "ready") {
      res.status(200).json({
        ...base,
        sourceCount: resolution.sourceCount,
        status: resolution.kind,
        sourceCourseId: null,
        sourceName: null,
        course: null,
        counts: null,
        noStandaloneSetupLessons: [],
        latestRun: null,
        latestCompletedRun: null,
        isOutOfDate: false,
        canSynthesizeNow: false,
        preflight: null,
      });
      return;
    }

    const payload = await buildSynthesisStatusPayload(deps, resolution.course);
    res.status(200).json({
      ...base,
      sourceCount: 1,
      status: "ready",
      sourceCourseId: resolution.course.id,
      sourceName: resolution.course.title,
      ...payload,
    });
  };
}

/**
 * POST /api/projects/:projectId/synthesis — the project-aware counterpart
 * to POST /api/course/synthesize. Resolves the project's course the same
 * way as the status handler above, then delegates to the unmodified
 * `handleSynthesizeForCourse` (same preflight/readiness gates, same
 * synthesis_runs row shape, same worker Job trigger). A project that isn't
 * TRADING_STRATEGIES, or that owns zero or multiple courses, is refused
 * deterministically with 409 — never a silent choice and never a fallback
 * to the globally configured course.
 */
export function createProjectSynthesizeHandler(deps: ProjectSynthesisRouteDeps) {
  return async function projectSynthesizeHandler(req: Request, res: Response): Promise<void> {
    const projectId = parseProjectId(req);
    if (projectId === null) {
      projectNotFound(res);
      return;
    }

    const resolution = await resolveProjectSynthesisSource(deps.pool, projectId);
    if (resolution.kind === "not_found") {
      projectNotFound(res);
      return;
    }
    if (resolution.kind !== "ready") {
      res.status(409).json({ error: { message: UNSUPPORTED_MESSAGES[resolution.kind], type: resolution.kind } });
      return;
    }

    const body = req.body as { force?: boolean };
    const force = body?.force === true;
    await handleSynthesizeForCourse(deps, res, resolution.course, force);
  };
}

/**
 * GET /api/projects/:projectId/synthesis — the project-aware counterpart
 * to GET /api/course/synthesis. Resolves the project's course, then
 * delegates to the unmodified `buildFullSynthesisPayload` — the exact same
 * clusters/canonicalStrategies/coreFramework/playbook/decisionFramework
 * data the legacy endpoint returns, never regenerated or duplicated.
 */
export function createGetProjectSynthesisHandler(deps: ProjectSynthesisRouteDeps) {
  return async function getProjectSynthesisHandler(req: Request, res: Response): Promise<void> {
    const projectId = parseProjectId(req);
    if (projectId === null) {
      projectNotFound(res);
      return;
    }

    const resolution = await resolveProjectSynthesisSource(deps.pool, projectId);
    if (resolution.kind === "not_found") {
      projectNotFound(res);
      return;
    }

    const base = { projectId, projectType: resolution.project.projectType };
    if (resolution.kind !== "ready") {
      res.status(200).json({
        ...base,
        sourceCount: resolution.sourceCount,
        status: resolution.kind,
        sourceCourseId: null,
        sourceName: null,
        run: null,
      });
      return;
    }

    const payload = await buildFullSynthesisPayload(deps, resolution.course);
    res.status(200).json({
      ...base,
      sourceCount: 1,
      status: payload.run ? "ready" : "no_run",
      sourceCourseId: resolution.course.id,
      sourceName: resolution.course.title,
      ...payload,
    });
  };
}
