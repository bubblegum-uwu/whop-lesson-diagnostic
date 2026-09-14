import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getProjectSourceById, listProjectSourceIdsByCollectionId } from "../../db/projectSourcesRepo.js";
import { resolveOwnedCollectionGroup } from "./sourceCollections.js";
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
  bulkAddSourcesToSynthesisSet,
  bulkRemoveSourcesFromSynthesisSet,
  listSynthesisSetSourceIdsForCollection,
  getSynthesisSetReadiness,
  getReadinessBySynthesisSetId,
  type SynthesisSetReadiness,
} from "../../db/synthesisSetSourcesRepo.js";
import { getLatestByProjectSource, listEligibleProjectSourceIdsInCollection } from "../../db/projectSourceAnalysesRepo.js";
import { toProjectSource } from "./projectSources.js";

export interface SynthesisSetsRouteDeps {
  pool: Pool;
}

const NOT_FOUND_RESPONSE = { error: { message: "Unknown synthesis set.", type: "synthesis_set_not_found" } } as const;
const PROJECT_NOT_FOUND_RESPONSE = { error: { message: "Unknown project.", type: "project_not_found" } } as const;
const SOURCE_NOT_FOUND_RESPONSE = { error: { message: "Unknown project source.", type: "project_source_not_found" } } as const;
const COLLECTION_NOT_FOUND_RESPONSE = { error: { message: "Unknown source collection.", type: "collection_not_found" } } as const;
const NOT_ELIGIBLE_RESPONSE = {
  error: { message: "This source has no usable successful analysis yet — only analyzed sources can be selected into a Synthesis Set.", type: "source_not_eligible" },
} as const;

/** Phase 4L — the single "has this source ever completed a successful analysis" check, reused by every eligibility gate below; never a new boolean flag (see projectSourceAnalysesRepo.getLatestByProjectSource's doc comment). */
async function isSourceEligibleForSynthesis(pool: Pool, projectSourceId: number): Promise<boolean> {
  const latest = await getLatestByProjectSource(pool, projectSourceId);
  return latest != null && (latest.status === "completed" || latest.status === "no_strategy");
}

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
    // Phase 4L follow-up — Synthesis Sets exist to select sources for a
    // future Trading-Strategies-only synthesis run; a GENERAL_KNOWLEDGE
    // source can never become eligible in the first place (it can never be
    // analyzed — see projectSourceAnalysis.ts's own project-type gate), so
    // creating a set here would only ever produce a permanently-empty,
    // pointless row. Fails safely rather than exposing set-management UI
    // for a project type it can never do anything useful for.
    if (project.projectType !== "TRADING_STRATEGIES") {
      res.status(400).json({
        error: { message: "Synthesis Sets are not available for General Knowledge projects yet.", type: "synthesis_sets_not_available_for_project_type" },
      });
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
 * Phase 4L — ALSO enforces eligibility server-side (never just a disabled
 * frontend checkbox): only a source with a usable successful analysis (see
 * isSourceEligibleForSynthesis) may be selected. This is the gap the
 * original Phase 4J handler left open.
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
    if (!(await isSourceEligibleForSynthesis(deps.pool, sourceId))) {
      res.status(400).json(NOT_ELIGIBLE_RESPONSE);
      return;
    }

    const { created } = await addSourceToSynthesisSet(deps.pool, set.id, sourceId, set.projectId);
    res.status(created ? 201 : 200).json({ synthesisSetId: set.id, sourceId, added: created });
  };
}

interface BulkSourcesBody {
  add?: unknown;
  remove?: unknown;
}

function parseIntegerIdArray(value: unknown): number[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (!value.every((id): id is number => typeof id === "number" && Number.isInteger(id))) return null;
  return value;
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/sources/bulk — the
 * fine-tune editor's "select all visible eligible" / "deselect all
 * visible" actions: an explicit, caller-supplied list of ids (never a
 * server-resolved collection — see the collection endpoints below for
 * that), still validated exactly like the singular add/remove routes:
 * every `add` id must belong to this project AND be eligible (an
 * ineligible or foreign id is silently skipped, never a partial-batch
 * error — the frontend never lets an ineligible row be checked in the
 * first place, this is defense-in-depth); every `remove` id is just a
 * membership delete, safe whether or not it was ever a member.
 */
export function createBulkUpdateSynthesisSetSourcesHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkUpdateSynthesisSetSourcesHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const body = req.body as BulkSourcesBody;
    const addIds = parseIntegerIdArray(body?.add);
    const removeIds = parseIntegerIdArray(body?.remove);
    if (addIds === null || removeIds === null) {
      res.status(400).json({ error: { message: "add/remove must be arrays of integer source ids.", type: "invalid_request" } });
      return;
    }

    let addedCount = 0;
    let ineligibleSkippedCount = 0;
    if (addIds.length > 0) {
      const eligibleAddIds: number[] = [];
      for (const sourceId of addIds) {
        const source = await getProjectSourceById(deps.pool, sourceId);
        if (!source || source.projectId !== set.projectId || !(await isSourceEligibleForSynthesis(deps.pool, sourceId))) {
          ineligibleSkippedCount++;
          continue;
        }
        eligibleAddIds.push(sourceId);
      }
      ({ addedCount } = await bulkAddSourcesToSynthesisSet(deps.pool, set.id, set.projectId, eligibleAddIds));
    }

    let removedCount = 0;
    if (removeIds.length > 0) {
      ({ removedCount } = await bulkRemoveSourcesFromSynthesisSet(deps.pool, set.id, removeIds));
    }

    res.status(200).json({ synthesisSetId: set.id, addedCount, ineligibleSkippedCount, removedCount });
  };
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/collections/:collectionId
 * — "select this whole collection": an explicit, one-time BULK action that
 * adds every CURRENTLY eligible member of the collection. Never a live
 * rule (spec's core invariant) — a source imported into this collection
 * tomorrow, or analyzed tomorrow, never joins this set on its own; the user
 * must repeat this action (or use the fine-tune editor) to add it.
 *
 * Phase 4L taxonomy correction — `:collectionId` accepts either a
 * persisted numeric collection id or a derived groupKey, resolved via
 * resolveOwnedCollectionGroup (the exact same resolver the Sources page's
 * group list and Analyze Collection use) — a Synthesis Set's group
 * checkbox always selects exactly the sources its card shows.
 */
export function createBulkAddCollectionToSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkAddCollectionToSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const resolvedGroup = await resolveOwnedCollectionGroup(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolvedGroup) {
      res.status(404).json(COLLECTION_NOT_FOUND_RESPONSE);
      return;
    }

    let allMemberIds: number[];
    let eligibleIds: number[];
    if (resolvedGroup.kind === "PERSISTED") {
      const collectionId = resolvedGroup.collection.id;
      [allMemberIds, eligibleIds] = await Promise.all([
        listProjectSourceIdsByCollectionId(deps.pool, collectionId),
        listEligibleProjectSourceIdsInCollection(deps.pool, collectionId),
      ]);
    } else {
      allMemberIds = resolvedGroup.memberSourceIds;
      eligibleIds = [];
      for (const sourceId of allMemberIds) {
        if (await isSourceEligibleForSynthesis(deps.pool, sourceId)) eligibleIds.push(sourceId);
      }
    }

    const currentSetMemberIds = await listProjectSourceIdsForSynthesisSet(deps.pool, set.id);
    const currentSetMemberIdSet = new Set(currentSetMemberIds);
    const alreadySelectedCount = eligibleIds.filter((id) => currentSetMemberIdSet.has(id)).length;
    const { addedCount } = await bulkAddSourcesToSynthesisSet(deps.pool, set.id, set.projectId, eligibleIds);

    res.status(200).json({
      collectionId: resolvedGroup.groupKey,
      eligibleCount: eligibleIds.length,
      alreadySelectedCount,
      addedCount,
      ineligibleCount: allMemberIds.length - eligibleIds.length,
    });
  };
}

/**
 * DELETE .../synthesis-sets/:setId/collections/:collectionId — "remove
 * this collection": bulk-removes ONLY the collection's current sources
 * that are members of THIS set, from THIS set only. Never deletes the
 * collection, its sources, their analyses, or membership in any other
 * Synthesis Set.
 *
 * Phase 4L taxonomy correction — `:collectionId` accepts either a
 * persisted numeric collection id or a derived groupKey (resolved via
 * resolveOwnedCollectionGroup, same as the add handler above). For a
 * derived group there's no `project_sources.collection_id` column to join
 * on, so this intersects the set's CURRENT membership with the group's
 * CURRENT membership instead — equivalent in effect, and still only ever
 * removes sources that are actually in both.
 */
export function createBulkRemoveCollectionFromSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkRemoveCollectionFromSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const resolvedGroup = await resolveOwnedCollectionGroup(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolvedGroup) {
      res.status(404).json(COLLECTION_NOT_FOUND_RESPONSE);
      return;
    }

    let memberIds: number[];
    if (resolvedGroup.kind === "PERSISTED") {
      memberIds = await listSynthesisSetSourceIdsForCollection(deps.pool, set.id, resolvedGroup.collection.id);
    } else {
      const currentSetMemberIds = await listProjectSourceIdsForSynthesisSet(deps.pool, set.id);
      const groupMemberIdSet = new Set(resolvedGroup.memberSourceIds);
      memberIds = currentSetMemberIds.filter((id) => groupMemberIdSet.has(id));
    }
    const { removedCount } = await bulkRemoveSourcesFromSynthesisSet(deps.pool, set.id, memberIds);
    res.status(200).json({ collectionId: resolvedGroup.groupKey, removedCount });
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
