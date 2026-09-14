import type { Request, Response } from "express";
import type { Pool } from "pg";
import {
  listProjects,
  getProjectById,
  getProjectStats,
  getCollectionCountForProject,
  getCollectionCountsForProjects,
  createProject,
  type Project,
  type ProjectStats,
  type ProjectType,
} from "../../db/projectsRepo.js";

export interface ProjectsRouteDeps {
  pool: Pool;
}

/** The Projects list/detail response shape — ProjectStats plus the canonical collection count (see getCollectionCountForProject's doc comment). Both are always supplied together so a response can never carry stats without a matching collectionCount. */
type ProjectWithStats = Project & ProjectStats & { collectionCount: number };

function serialize(project: Project, stats: ProjectStats, collectionCount: number): ProjectWithStats {
  return { ...project, ...stats, collectionCount };
}

/**
 * GET /api/projects — every project visible to this deployment's operator.
 * Today that's exactly the seeded MasterMind row (see the Phase 4B
 * migration); a real multi-project list is what this reads once more
 * projects exist. Gated by the same operatorAuth middleware as every other
 * course/analysis route — no unauthenticated project data.
 *
 * Phase 4L follow-up — `collectionCount` is computed via
 * getCollectionCountsForProjects, batched across every project in ONE set
 * of round trips rather than once per project, so this list never N+1s
 * (the pre-existing per-project getProjectStats calls below are an
 * existing, separate N+1 this change doesn't widen further).
 */
export function createListProjectsHandler(deps: ProjectsRouteDeps) {
  return async function listProjectsHandler(_req: Request, res: Response): Promise<void> {
    const projects = await listProjects(deps.pool);
    const [statsList, collectionCounts] = await Promise.all([
      Promise.all(projects.map((project) => getProjectStats(deps.pool, project.id))),
      getCollectionCountsForProjects(deps.pool, projects.map((p) => p.id)),
    ]);
    const withStats = projects.map((project, i) => serialize(project, statsList[i], collectionCounts.get(project.id) ?? 0));
    res.status(200).json({ projects: withStats });
  };
}

/** GET /api/projects/:projectId — 404s on an unknown or non-numeric id rather than 500ing. */
export function createGetProjectHandler(deps: ProjectsRouteDeps) {
  return async function getProjectHandler(req: Request, res: Response): Promise<void> {
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

    const [stats, collectionCount] = await Promise.all([getProjectStats(deps.pool, project.id), getCollectionCountForProject(deps.pool, project.id)]);
    res.status(200).json({ project: serialize(project, stats, collectionCount) });
  };
}

/** Phase 4G — the only two project types this deployment supports; anything else is a deterministic 400, never silently coerced. */
const VALID_PROJECT_TYPES: ReadonlySet<string> = new Set(["TRADING_STRATEGIES", "GENERAL_KNOWLEDGE"]);

/** Generous but bounded — long enough for any real project name, short enough to keep the UI/DB sane. Not a security control, just sanity. */
const MAX_PROJECT_NAME_LENGTH = 200;

interface CreateProjectBody {
  name?: unknown;
  projectType?: unknown;
}

interface CreateProjectValidationError {
  message: string;
  type: string;
}

interface CreateProjectValidated {
  name: string;
  projectType: ProjectType;
}

/**
 * Pure validation, deliberately separated from the handler so it's trivial
 * to unit-test every rejection path without a database or an Express
 * request/response pair. Trims the name before every other check (so a
 * name that's only whitespace is correctly rejected as blank, not accepted
 * with leading/trailing spaces) and never mutates the input.
 */
export function validateCreateProjectBody(
  body: CreateProjectBody,
): { ok: true; value: CreateProjectValidated } | { ok: false; error: CreateProjectValidationError } {
  const rawName = body?.name;
  if (typeof rawName !== "string") {
    return { ok: false, error: { message: "Project name is required.", type: "invalid_name" } };
  }

  const name = rawName.trim();
  if (name.length === 0) {
    return { ok: false, error: { message: "Project name cannot be blank.", type: "invalid_name" } };
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return {
      ok: false,
      error: { message: `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer.`, type: "invalid_name" },
    };
  }

  const projectType = body?.projectType;
  if (typeof projectType !== "string" || !VALID_PROJECT_TYPES.has(projectType)) {
    return {
      ok: false,
      error: {
        message: "projectType must be one of TRADING_STRATEGIES or GENERAL_KNOWLEDGE.",
        type: "invalid_project_type",
      },
    };
  }

  return { ok: true, value: { name, projectType: projectType as ProjectType } };
}

/**
 * POST /api/projects — Phase 4G. Inserts exactly ONE `projects` row (see
 * db/projectsRepo.createProject's doc comment) and returns it as the same
 * shape GET /api/projects/:projectId does, so the frontend can navigate
 * straight to the new project's Sources page using the response alone —
 * no extra fetch needed. A freshly created project always has zero
 * courses/lessons/analyses/synthesis runs, so its stats are trivially all
 * zero/null; getProjectStats is still called (rather than hand-building a
 * zeroed object here) so this response shape can never silently drift from
 * GET's.
 */
export function createCreateProjectHandler(deps: ProjectsRouteDeps) {
  return async function createProjectHandler(req: Request, res: Response): Promise<void> {
    const validation = validateCreateProjectBody(req.body as CreateProjectBody);
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const project = await createProject(deps.pool, validation.value.name, validation.value.projectType);
    // A freshly created project has no sources of any kind yet, so its
    // collectionCount is trivially 0 — still computed via
    // getCollectionCountForProject (rather than hand-written as 0) so this
    // response shape can never silently drift from GET's.
    const [stats, collectionCount] = await Promise.all([getProjectStats(deps.pool, project.id), getCollectionCountForProject(deps.pool, project.id)]);
    res.status(201).json({ project: serialize(project, stats, collectionCount) });
  };
}
