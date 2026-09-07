import type { Request, Response } from "express";
import type { Pool } from "pg";
import { listProjects, getProjectById, getProjectStats, type Project, type ProjectStats, type ProjectWithStats } from "../../db/projectsRepo.js";

export interface ProjectsRouteDeps {
  pool: Pool;
}

function serialize(project: Project, stats: ProjectStats): ProjectWithStats {
  return { ...project, ...stats };
}

/**
 * GET /api/projects — every project visible to this deployment's operator.
 * Today that's exactly the seeded MasterMind row (see the Phase 4B
 * migration); a real multi-project list is what this reads once more
 * projects exist. Gated by the same operatorAuth middleware as every other
 * course/analysis route — no unauthenticated project data.
 */
export function createListProjectsHandler(deps: ProjectsRouteDeps) {
  return async function listProjectsHandler(_req: Request, res: Response): Promise<void> {
    const projects = await listProjects(deps.pool);
    const withStats = await Promise.all(
      projects.map(async (project) => serialize(project, await getProjectStats(deps.pool, project.id))),
    );
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

    const stats = await getProjectStats(deps.pool, project.id);
    res.status(200).json({ project: serialize(project, stats) });
  };
}
