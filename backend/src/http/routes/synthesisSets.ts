import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getProjectSourceById } from "../../db/projectSourcesRepo.js";
import {
  createSynthesisSet,
  listSynthesisSetsByProjectId,
  getSynthesisSetById,
  updateSynthesisSet,
  deleteSynthesisSet,
  type SynthesisSetRow,
} from "../../db/synthesisSetsRepo.js";
import {
  addSourceToSynthesisSet,
  removeSourceFromSynthesisSet,
  listProjectSourceIdsForSynthesisSet,
  getSynthesisSetReadiness,
  getReadinessBySynthesisSetId,
  type SynthesisSetReadiness,
} from "../../db/synthesisSetSourcesRepo.js";
import { getLatestByProjectSource } from "../../db/projectSourceAnalysesRepo.js";
import { toProjectSource } from "./projectSources.js";

export interface SynthesisSetsRouteDeps {
  pool: Pool;
}

const NOT_FOUND_RESPONSE = { error: { message: "Unknown synthesis set.", type: "synthesis_set_not_found" } } as const;
const PROJECT_NOT_FOUND_RESPONSE = { error: { message: "Unknown project.", type: "project_not_found" } } as const;
const SOURCE_NOT_FOUND_RESPONSE = { error: { message: "Unknown project source.", type: "project_source_not_found" } } as const;

/**
 * Phase 4J — every route below enforces ownership the same way the
 * existing project-source-analysis routes do (see
 * http/routes/projectSourceAnalysis.ts's resolveOwnedSource doc comment):
 * the set must exist AND belong to the requested project. Never trusts
 * setId alone. Returns the same deterministic 404 whether the project is
 * unknown, the set is unknown, or the set belongs to a DIFFERENT project —
 * never leaking which case it was.
 */
async function resolveOwnedSynthesisSet(pool: Pool, projectIdParam: string | string[], setIdParam: string | string[]) {
  const projectId = Number(projectIdParam);
  const setId = Number(setIdParam);
  if (!Number.isInteger(projectId) || !Number.isInteger(setId)) return null;

  const project = await getProjectById(pool, projectId);
  if (!project) return null;

  const set = await getSynthesisSetById(pool, setId);
  if (!set || set.projectId !== projectId) return null;

  return { project, set };
}

function toSynthesisSetSummary(set: SynthesisSetRow, readiness: SynthesisSetReadiness) {
  return {
    id: set.id,
    projectId: set.projectId,
    name: set.name,
    description: set.description,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    sourceCount: readiness.sourceCount,
    analyzedSourceCount: readiness.analyzedSourceCount,
    needsAnalysisCount: readiness.needsAnalysisCount,
  };
}

/** GET /api/projects/:projectId/synthesis-sets — every Synthesis Set this project owns, with a rolled-up readiness summary per set (no full source list — see the detail handler for that). Pure read; never enqueues or triggers analysis. */
export function createListSynthesisSetsHandler(deps: SynthesisSetsRouteDeps) {
  return async function listSynthesisSetsHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(PROJECT_NOT_FOUND_RESPONSE);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(PROJECT_NOT_FOUND_RESPONSE);
      return;
    }

    const sets = await listSynthesisSetsByProjectId(deps.pool, projectId);
    const readinessById = await getReadinessBySynthesisSetId(deps.pool, sets.map((s) => s.id));
    const synthesisSets = sets.map((set) => toSynthesisSetSummary(set, readinessById.get(set.id) ?? { sourceCount: 0, analyzedSourceCount: 0, needsAnalysisCount: 0 }));

    res.status(200).json({ projectId, synthesisSets });
  };
}

interface CreateSynthesisSetBody {
  name?: unknown;
  description?: unknown;
}

/**
 * POST /api/projects/:projectId/synthesis-sets — creates an empty,
 * persistent Synthesis Set configuration. Never analyzes anything, never
 * creates a synthesis, never adds any source — membership is a separate,
 * explicit follow-up action (see createAddSourceToSynthesisSetHandler).
 * `name` is required (non-empty after trimming); `description` is
 * optional.
 */
export function createCreateSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function createSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(PROJECT_NOT_FOUND_RESPONSE);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(PROJECT_NOT_FOUND_RESPONSE);
      return;
    }

    const body = req.body as CreateSynthesisSetBody;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length === 0) {
      res.status(400).json({ error: { message: "Name is required.", type: "invalid_request" } });
      return;
    }
    const description = typeof body?.description === "string" && body.description.trim().length > 0 ? body.description.trim() : null;

    const set = await createSynthesisSet(deps.pool, { projectId, name, description });
    res.status(201).json(toSynthesisSetSummary(set, { sourceCount: 0, analyzedSourceCount: 0, needsAnalysisCount: 0 }));
  };
}

/**
 * GET /api/projects/:projectId/synthesis-sets/:setId — full detail,
 * including the member source list with each source's own analysis
 * readiness (never a fabricated/rolled-up-only view). Pure read.
 */
export function createGetSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function getSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const sourceIds = await listProjectSourceIdsForSynthesisSet(deps.pool, set.id);
    const [sourceRows, readiness] = await Promise.all([
      Promise.all(sourceIds.map((id) => getProjectSourceById(deps.pool, id))),
      getSynthesisSetReadiness(deps.pool, set.id),
    ]);
    const sources = await Promise.all(
      sourceRows.filter((row): row is NonNullable<typeof row> => row !== null).map(async (row) => {
        const latestAnalysis = await getLatestByProjectSource(deps.pool, row.id);
        const analyzed = latestAnalysis != null && (latestAnalysis.status === "completed" || latestAnalysis.status === "no_strategy");
        return { ...toProjectSource(row), analyzed };
      }),
    );

    res.status(200).json({ ...toSynthesisSetSummary(set, readiness), sources });
  };
}

interface UpdateSynthesisSetBody {
  name?: unknown;
  description?: unknown;
}

/** PATCH /api/projects/:projectId/synthesis-sets/:setId — rename and/or update description. Nothing else about a Synthesis Set is mutable in Phase 4J; membership changes go through the dedicated membership routes below. */
export function createUpdateSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function updateSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const body = req.body as UpdateSynthesisSetBody;
    const update: { name?: string; description?: string | null } = {};
    if (body?.name !== undefined) {
      const trimmed = typeof body.name === "string" ? body.name.trim() : "";
      if (trimmed.length === 0) {
        res.status(400).json({ error: { message: "Name cannot be empty.", type: "invalid_request" } });
        return;
      }
      update.name = trimmed;
    }
    if (body?.description !== undefined) {
      update.description = typeof body.description === "string" && body.description.trim().length > 0 ? body.description.trim() : null;
    }

    const updated = await updateSynthesisSet(deps.pool, set.id, update);
    const readiness = await getSynthesisSetReadiness(deps.pool, set.id);
    res.status(200).json(toSynthesisSetSummary(updated ?? set, readiness));
  };
}

/** DELETE /api/projects/:projectId/synthesis-sets/:setId — deletes the set and, via ON DELETE CASCADE, its memberships. Never deletes the underlying project_sources rows or their analyses. */
export function createDeleteSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function deleteSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    await deleteSynthesisSet(deps.pool, resolved.set.id);
    res.status(204).end();
  };
}

interface AddSourceBody {
  sourceId?: unknown;
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/sources — adds a
 * project_source to this set. Idempotent (section 11): a repeated add of
 * the same source returns 200 with the existing membership rather than an
 * error. Enforces `source.projectId === set.projectId` — a source from a
 * different project can never be attached (section 7).
 *
 * Deliberately does NOT: analyze the source, enqueue analysis, trigger
 * synthesis, modify project_sources.status, modify any existing analysis,
 * or touch any other synthesis set.
 */
export function createAddSourceToSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function addSourceToSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const body = req.body as AddSourceBody;
    const sourceId = Number(body?.sourceId);
    if (!Number.isInteger(sourceId)) {
      res.status(400).json({ error: { message: "sourceId is required.", type: "invalid_request" } });
      return;
    }

    const source = await getProjectSourceById(deps.pool, sourceId);
    if (!source || source.projectId !== set.projectId) {
      res.status(404).json(SOURCE_NOT_FOUND_RESPONSE);
      return;
    }

    const { created } = await addSourceToSynthesisSet(deps.pool, set.id, sourceId, set.projectId);
    res.status(created ? 201 : 200).json({ synthesisSetId: set.id, sourceId, added: created });
  };
}

/** DELETE /api/projects/:projectId/synthesis-sets/:setId/sources/:sourceId — removes membership only. Never deletes the source or its analysis; never affects any other set the source also belongs to. */
export function createRemoveSourceFromSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function removeSourceFromSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const sourceId = Number(req.params.sourceId);
    if (!Number.isInteger(sourceId)) {
      res.status(404).json(SOURCE_NOT_FOUND_RESPONSE);
      return;
    }

    await removeSourceFromSynthesisSet(deps.pool, set.id, sourceId);
    res.status(204).end();
  };
}
