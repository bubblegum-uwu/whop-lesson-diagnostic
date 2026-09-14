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
import { getCoursesByProjectId } from "../../db/coursesRepo.js";
import { getLessonById, listLessons } from "../../db/lessonsRepo.js";
import { getWhopLessonAnalysisStatus } from "../../db/whopLessonAnalysisStatusRepo.js";
import { getLessonIdsOwnedByProject } from "../../db/lessonProjectAccessRepo.js";
import {
  addLessonToSynthesisSet,
  removeLessonFromSynthesisSet,
  listLessonIdsForSynthesisSet,
  bulkAddLessonsToSynthesisSet,
  bulkRemoveLessonsFromSynthesisSet,
  listSynthesisSetLessonIdsForCourse,
  getSynthesisSetLessonReadiness,
  getLessonReadinessBySynthesisSetId,
  type SynthesisSetLessonReadiness,
} from "../../db/synthesisSetLessonsRepo.js";
import { listLegacyRunIdsForSynthesisSet } from "../../db/synthesisSetLegacyRunsRepo.js";
import { getSynthesisRunsByIds, type SynthesisRun } from "../../db/synthesisRunsRepo.js";
import { getCoursePlaybookByRun } from "../../db/coursePlaybooksRepo.js";

export interface SynthesisSetsRouteDeps {
  pool: Pool;
}

const EMPTY_LESSON_READINESS: SynthesisSetLessonReadiness = { lessonCount: 0, analyzedLessonCount: 0, needsAnalysisCount: 0 };
const COURSE_NOT_FOUND_RESPONSE = { error: { message: "Unknown Whop course.", type: "course_not_found" } } as const;
const LESSON_NOT_FOUND_RESPONSE = { error: { message: "Unknown Whop lesson.", type: "lesson_not_found" } } as const;
const NOT_ELIGIBLE_LESSON_RESPONSE = {
  error: { message: "This lesson has no usable successful analysis yet — only analyzed lessons can be selected into a Synthesis Set.", type: "lesson_not_eligible" },
} as const;
const RUN_NOT_FOUND_RESPONSE = { error: { message: "Unknown legacy synthesis run for this set.", type: "legacy_run_not_found" } } as const;
const PLAYBOOK_NOT_FOUND_RESPONSE = { error: { message: "No playbook exists for this run.", type: "playbook_not_found" } } as const;

/** Pre-4M — the same "does this course belong to this project" check whopCourses.ts's own (unexported) resolveOwnedCourse uses: ownership is proven by the course appearing in the project's own course list, never by trusting a raw courseId param alone. */
async function resolveOwnedCourseForProject(pool: Pool, projectId: number, courseId: number) {
  if (!Number.isInteger(courseId)) return null;
  const courses = await getCoursesByProjectId(pool, projectId);
  return courses.find((c) => c.id === courseId) ?? null;
}

/** Pre-4M — the one "has this lesson ever completed a successful analysis" check, reused by every lesson-membership eligibility gate below; mirrors isSourceEligibleForSynthesis above but against lesson_analyses (see whopLessonAnalysisStatusRepo.ts). */
async function isLessonEligibleForSynthesis(pool: Pool, lessonId: number): Promise<boolean> {
  const statusById = await getWhopLessonAnalysisStatus(pool, [lessonId]);
  return statusById.get(lessonId)?.eligibleForSynthesis ?? false;
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

/**
 * Pre-4M — the set's headline counts now combine BOTH membership kinds
 * (synthesis_set_sources + synthesis_set_lessons — see the task's own
 * "CURRENT SYNTHESIS SET MEMBERSHIP" requirement: "selected count should
 * include: synthesis_set_sources, synthesis_set_lessons"). `lessonReadiness`
 * defaults to zero so every pre-existing call site that hasn't been taught
 * about lessons yet still produces the exact same numbers as before this
 * bridge existed.
 */
function toSynthesisSetSummary(set: SynthesisSetRow, sourceReadiness: SynthesisSetReadiness, lessonReadiness: SynthesisSetLessonReadiness = EMPTY_LESSON_READINESS) {
  return {
    id: set.id,
    projectId: set.projectId,
    name: set.name,
    description: set.description,
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    sourceCount: sourceReadiness.sourceCount + lessonReadiness.lessonCount,
    analyzedSourceCount: sourceReadiness.analyzedSourceCount + lessonReadiness.analyzedLessonCount,
    needsAnalysisCount: sourceReadiness.needsAnalysisCount + lessonReadiness.needsAnalysisCount,
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
    const setIds = sets.map((s) => s.id);
    const [readinessById, lessonReadinessById] = await Promise.all([getReadinessBySynthesisSetId(deps.pool, setIds), getLessonReadinessBySynthesisSetId(deps.pool, setIds)]);
    const synthesisSets = sets.map((set) =>
      toSynthesisSetSummary(set, readinessById.get(set.id) ?? { sourceCount: 0, analyzedSourceCount: 0, needsAnalysisCount: 0 }, lessonReadinessById.get(set.id) ?? EMPTY_LESSON_READINESS),
    );

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
 * Pre-4M — a Whop lesson member of a Synthesis Set, shaped distinctly from
 * a project_source member (`kind: "WHOP_LESSON"` discriminator) rather than
 * flattened into the YouTube/Discord source shape — see the task's own
 * "Do not flatten Whop lessons into YouTube-like source rows internally."
 * `analyzed` uses the exact same lesson_analyses eligibility rule as
 * isLessonEligibleForSynthesis above.
 */
interface SynthesisSetMemberLesson {
  kind: "WHOP_LESSON";
  id: number;
  courseId: number;
  title: string;
  chapterTitle: string | null;
  sourceUrl: string;
  durationSeconds: number | null;
  analyzed: boolean;
}

async function buildSynthesisSetMemberLessons(pool: Pool, lessonIds: number[]): Promise<SynthesisSetMemberLesson[]> {
  if (lessonIds.length === 0) return [];
  const [lessons, statusByLesson] = await Promise.all([
    Promise.all(lessonIds.map((id) => getLessonById(pool, id))),
    getWhopLessonAnalysisStatus(pool, lessonIds),
  ]);
  return lessons
    .filter((l): l is NonNullable<typeof l> => l !== null)
    .map((l) => ({
      kind: "WHOP_LESSON" as const,
      id: l.id,
      courseId: l.courseId,
      title: l.title,
      chapterTitle: l.chapterTitle,
      sourceUrl: l.sourceUrl,
      durationSeconds: l.durationSeconds,
      analyzed: statusByLesson.get(l.id)?.eligibleForSynthesis ?? false,
    }));
}

/**
 * GET /api/projects/:projectId/synthesis-sets/:setId — full detail,
 * including the member source list with each source's own analysis
 * readiness (never a fabricated/rolled-up-only view), PLUS (pre-4M) the
 * member Whop lesson list, kept as a separate typed array rather than
 * merged into `sources` — see SynthesisSetMemberLesson's doc comment. Pure
 * read.
 */
export function createGetSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function getSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const [sourceIds, lessonIds] = await Promise.all([listProjectSourceIdsForSynthesisSet(deps.pool, set.id), listLessonIdsForSynthesisSet(deps.pool, set.id)]);
    const [sourceRows, readiness, lessonReadiness, lessons] = await Promise.all([
      Promise.all(sourceIds.map((id) => getProjectSourceById(deps.pool, id))),
      getSynthesisSetReadiness(deps.pool, set.id),
      getSynthesisSetLessonReadiness(deps.pool, set.id),
      buildSynthesisSetMemberLessons(deps.pool, lessonIds),
    ]);
    const sources = await Promise.all(
      sourceRows.filter((row): row is NonNullable<typeof row> => row !== null).map(async (row) => {
        const latestAnalysis = await getLatestByProjectSource(deps.pool, row.id);
        const analyzed = latestAnalysis != null && (latestAnalysis.status === "completed" || latestAnalysis.status === "no_strategy");
        return { ...toProjectSource(row), analyzed };
      }),
    );

    res.status(200).json({ ...toSynthesisSetSummary(set, readiness, lessonReadiness), sources, lessons });
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
    const [readiness, lessonReadiness] = await Promise.all([getSynthesisSetReadiness(deps.pool, set.id), getSynthesisSetLessonReadiness(deps.pool, set.id)]);
    res.status(200).json(toSynthesisSetSummary(updated ?? set, readiness, lessonReadiness));
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

// =============================================================================
// Pre-4M — Whop lesson membership (synthesis_set_lessons). Mirrors the
// project_source membership handlers above exactly in shape/semantics
// (idempotent add, plain remove, eligibility server-side-enforced, snapshot
// bulk add never a live rule) — only the underlying table and ownership
// check differ. See lessonProjectAccessRepo.ts / synthesisSetLessonsRepo.ts.
// =============================================================================

interface AddLessonBody {
  lessonId?: unknown;
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/lessons — adds a
 * Whop lesson to this set. Idempotent, mirrors createAddSourceToSynthesisSetHandler.
 * Enforces BOTH lesson-project ownership (course.project_id === set.projectId
 * OR a project_whop_lesson_imports row — see lessonProjectAccessRepo.ts,
 * never a database FK alone, since `lessons` has no project_id column) AND
 * eligibility server-side. Never analyzes, never enqueues, never touches
 * lesson_analyses.
 */
export function createAddLessonToSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function addLessonToSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const body = req.body as AddLessonBody;
    const lessonId = Number(body?.lessonId);
    if (!Number.isInteger(lessonId)) {
      res.status(400).json({ error: { message: "lessonId is required.", type: "invalid_request" } });
      return;
    }

    const lesson = await getLessonById(deps.pool, lessonId);
    const owned = lesson != null && (await getLessonIdsOwnedByProject(deps.pool, [lessonId], set.projectId)).has(lessonId);
    if (!owned) {
      res.status(404).json(LESSON_NOT_FOUND_RESPONSE);
      return;
    }
    if (!(await isLessonEligibleForSynthesis(deps.pool, lessonId))) {
      res.status(400).json(NOT_ELIGIBLE_LESSON_RESPONSE);
      return;
    }

    const { created } = await addLessonToSynthesisSet(deps.pool, set.id, lessonId, set.projectId);
    res.status(created ? 201 : 200).json({ synthesisSetId: set.id, lessonId, added: created });
  };
}

/** DELETE /api/projects/:projectId/synthesis-sets/:setId/lessons/:lessonId — removes membership only. Never deletes the lesson or its analysis. */
export function createRemoveLessonFromSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function removeLessonFromSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const lessonId = Number(req.params.lessonId);
    if (!Number.isInteger(lessonId)) {
      res.status(404).json(LESSON_NOT_FOUND_RESPONSE);
      return;
    }

    await removeLessonFromSynthesisSet(deps.pool, set.id, lessonId);
    res.status(204).end();
  };
}

interface BulkLessonsBody {
  add?: unknown;
  remove?: unknown;
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/lessons/bulk — the
 * Fine-Tune editor's "select/deselect all visible" actions applied to Whop
 * lesson rows, mirroring createBulkUpdateSynthesisSetSourcesHandler exactly:
 * every `add` id must be owned by this project AND eligible (silently
 * skipped otherwise, defense-in-depth — the frontend never lets an
 * ineligible/foreign row be checked); every `remove` id is just a
 * membership delete.
 */
export function createBulkUpdateSynthesisSetLessonsHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkUpdateSynthesisSetLessonsHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const body = req.body as BulkLessonsBody;
    const addIds = parseIntegerIdArray(body?.add);
    const removeIds = parseIntegerIdArray(body?.remove);
    if (addIds === null || removeIds === null) {
      res.status(400).json({ error: { message: "add/remove must be arrays of integer lesson ids.", type: "invalid_request" } });
      return;
    }

    let addedCount = 0;
    let ineligibleSkippedCount = 0;
    if (addIds.length > 0) {
      const ownedIds = await getLessonIdsOwnedByProject(deps.pool, addIds, set.projectId);
      const eligibleAddIds: number[] = [];
      for (const lessonId of addIds) {
        if (!ownedIds.has(lessonId) || !(await isLessonEligibleForSynthesis(deps.pool, lessonId))) {
          ineligibleSkippedCount++;
          continue;
        }
        eligibleAddIds.push(lessonId);
      }
      ({ addedCount } = await bulkAddLessonsToSynthesisSet(deps.pool, set.id, set.projectId, eligibleAddIds));
    }

    let removedCount = 0;
    if (removeIds.length > 0) {
      ({ removedCount } = await bulkRemoveLessonsFromSynthesisSet(deps.pool, set.id, removeIds));
    }

    res.status(200).json({ synthesisSetId: set.id, addedCount, ineligibleSkippedCount, removedCount });
  };
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/whop-courses/:courseId
 * — "select this whole Whop course": an explicit, one-time BULK snapshot
 * action adding every CURRENTLY eligible lesson of a course FULLY connected
 * to this project (courses.project_id === projectId — mirrors
 * createBulkAddCollectionToSynthesisSetHandler's collection-snapshot
 * semantics exactly, never a live rule: a lesson added to the course later,
 * or analyzed later, never auto-joins this set).
 */
export function createBulkAddCourseToSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkAddCourseToSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const courseId = Number(req.params.courseId);
    const course = await resolveOwnedCourseForProject(deps.pool, set.projectId, courseId);
    if (!course) {
      res.status(404).json(COURSE_NOT_FOUND_RESPONSE);
      return;
    }

    const allLessons = await listLessons(deps.pool, course.id);
    const allLessonIds = allLessons.map((l) => l.id);
    const statusByLesson = await getWhopLessonAnalysisStatus(deps.pool, allLessonIds);
    const eligibleIds = allLessonIds.filter((id) => statusByLesson.get(id)?.eligibleForSynthesis);

    const currentSetLessonIds = new Set(await listLessonIdsForSynthesisSet(deps.pool, set.id));
    const alreadySelectedCount = eligibleIds.filter((id) => currentSetLessonIds.has(id)).length;
    const { addedCount } = await bulkAddLessonsToSynthesisSet(deps.pool, set.id, set.projectId, eligibleIds);

    res.status(200).json({
      courseId: course.id,
      eligibleCount: eligibleIds.length,
      alreadySelectedCount,
      addedCount,
      ineligibleCount: allLessonIds.length - eligibleIds.length,
    });
  };
}

/**
 * DELETE .../synthesis-sets/:setId/whop-courses/:courseId — "remove this
 * course": bulk-removes ONLY this set's current lesson members belonging to
 * that course, from THIS set only. Never deletes the course, its lessons,
 * or their analyses.
 */
export function createBulkRemoveCourseFromSynthesisSetHandler(deps: SynthesisSetsRouteDeps) {
  return async function bulkRemoveCourseFromSynthesisSetHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const courseId = Number(req.params.courseId);
    const course = await resolveOwnedCourseForProject(deps.pool, set.projectId, courseId);
    if (!course) {
      res.status(404).json(COURSE_NOT_FOUND_RESPONSE);
      return;
    }

    const lessonIds = await listSynthesisSetLessonIdsForCourse(deps.pool, set.id, course.id);
    const { removedCount } = await bulkRemoveLessonsFromSynthesisSet(deps.pool, set.id, lessonIds);
    res.status(200).json({ courseId: course.id, removedCount });
  };
}

// =============================================================================
// Pre-4M — legacy Whop synthesis history (synthesis_set_legacy_runs). VIEW
// -ONLY: nothing here creates a synthesis_runs row, triggers a run, or
// mutates synthesis_runs/course_playbooks. Attachment itself happens only
// via scripts/recoverLegacyWhopSynthesis.ts (see that script's doc
// comment) — there is deliberately no HTTP route to attach a run, since
// this bridge exists purely to surface already-recovered history, not to
// let a user attach arbitrary runs through the API.
// =============================================================================

interface LegacySynthesisRunSummary {
  runId: string;
  status: SynthesisRun["status"];
  createdAt: Date;
  completedAt: Date | null;
  model: string;
  synthesisPromptVersion: string;
  synthesizerVersion: string;
  sourceAnalysisCount: number;
  errorType: string | null;
  sanitizedError: string | null;
  hasPlaybook: boolean;
}

function toLegacyRunSummary(run: SynthesisRun, hasPlaybook: boolean): LegacySynthesisRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    model: run.model,
    synthesisPromptVersion: run.synthesisPromptVersion,
    synthesizerVersion: run.synthesizerVersion,
    sourceAnalysisCount: run.sourceAnalysisIds.length,
    errorType: run.errorType,
    sanitizedError: run.sanitizedError,
    hasPlaybook,
  };
}

/**
 * GET /api/projects/:projectId/synthesis-sets/:setId/legacy-runs — every
 * legacy synthesis_runs row attached to this set (via the recovery script),
 * newest first, COMPLETED and FAILED alike — never discards failed history.
 * Never includes the playbook JSON itself (see the dedicated
 * .../legacy-runs/:runId/playbook endpoint below) — same "never send the
 * full JSON blob in a list response" precedent as project_source_analyses.
 */
export function createListLegacySynthesisRunsHandler(deps: SynthesisSetsRouteDeps) {
  return async function listLegacySynthesisRunsHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const runIds = await listLegacyRunIdsForSynthesisSet(deps.pool, set.id);
    const runs = await getSynthesisRunsByIds(deps.pool, runIds);
    // getSynthesisRunsByIds already orders by created_at DESC; re-sort defensively to match runIds' own newest-attached-first order isn't required — both orderings are "newest first" by construction.
    const summaries = await Promise.all(
      runs.map(async (run) => {
        const playbook = run.status === "COMPLETED" ? await getCoursePlaybookByRun(deps.pool, run.runId) : null;
        return toLegacyRunSummary(run, playbook !== null);
      }),
    );

    res.status(200).json({ synthesisSetId: set.id, runs: summaries });
  };
}

/**
 * GET .../synthesis-sets/:setId/legacy-runs/:runId/playbook — the existing,
 * immutable course_playbooks row for one attached COMPLETED legacy run:
 * core framework, playbook, decision framework. Never generates or mutates
 * anything; 404s if the run isn't attached to this set, or has no playbook
 * (e.g. a FAILED run).
 */
export function createGetLegacySynthesisPlaybookHandler(deps: SynthesisSetsRouteDeps) {
  return async function getLegacySynthesisPlaybookHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { set } = resolved;

    const runId = typeof req.params.runId === "string" ? req.params.runId : "";
    const attachedRunIds = await listLegacyRunIdsForSynthesisSet(deps.pool, set.id);
    if (!attachedRunIds.includes(runId)) {
      res.status(404).json(RUN_NOT_FOUND_RESPONSE);
      return;
    }

    const playbook = await getCoursePlaybookByRun(deps.pool, runId);
    if (!playbook) {
      res.status(404).json(PLAYBOOK_NOT_FOUND_RESPONSE);
      return;
    }

    res.status(200).json({
      runId,
      title: playbook.title,
      coreFramework: playbook.coreFramework,
      playbook: playbook.playbook,
      decisionFramework: playbook.decisionFramework,
    });
  };
}
