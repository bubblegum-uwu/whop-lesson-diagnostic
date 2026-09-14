import type { ProjectSource } from "./sourcesApi";

/**
 * Client for Phase 4J's Synthesis Set endpoints
 * (/api/projects/:projectId/synthesis-sets...). Requires the caller's
 * Knovera session token — never a Whop token; Synthesis Sets are a
 * project-level configuration concept, unrelated to whether Whop is
 * connected. Never calls anything Gemini/analysis-related — these are pure
 * CRUD + membership calls (see backend/src/http/routes/synthesisSets.ts).
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

/**
 * `sourceCount`/`analyzedSourceCount`/`needsAnalysisCount` are DERIVED on
 * every read (see the backend repo's doc comment) — never a stored status.
 * A source counts toward `sourceCount` the moment it's a member, whether or
 * not it has ever been analyzed; `needsAnalysisCount` is the difference,
 * never a silently-dropped remainder.
 */
export interface SynthesisSetSummary {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  analyzedSourceCount: number;
  needsAnalysisCount: number;
}

/** ProjectSource is a union (Whop/YouTube/Discord), so this is a type alias rather than an `extends` interface. */
export type SynthesisSetMemberSource = ProjectSource & {
  /** Whether this member source has ever completed analysis — independent of membership itself; see Phase 4J's "three concepts" rule. */
  analyzed: boolean;
};

/**
 * Pre-4M — a Whop lesson member of a Synthesis Set. Deliberately a
 * DISTINCT shape from SynthesisSetMemberSource rather than flattened into
 * it — a Whop lesson never lived in `project_sources` and this bridge
 * doesn't pretend otherwise (see backend/src/http/routes/synthesisSets.ts's
 * "Pre-4M" sections). `kind: "WHOP_LESSON"` is the discriminator the UI
 * uses to render it distinctly and to keep its id space (lessons.id) from
 * ever being confused with a project_source id.
 */
export interface SynthesisSetMemberLesson {
  kind: "WHOP_LESSON";
  id: number;
  courseId: number;
  title: string;
  chapterTitle: string | null;
  sourceUrl: string;
  durationSeconds: number | null;
  analyzed: boolean;
}

export interface SynthesisSetDetail extends SynthesisSetSummary {
  sources: SynthesisSetMemberSource[];
  /** Pre-4M — the set's Whop lesson members, kept as a separate typed array (see SynthesisSetMemberLesson's doc comment) rather than merged into `sources`. */
  lessons: SynthesisSetMemberLesson[];
}

export class SynthesisSetError extends Error {
  type: string;

  constructor(message: string, type: string) {
    super(message);
    this.name = "SynthesisSetError";
    this.type = type;
  }
}

async function readErrorBody(res: Response): Promise<{ message?: string; type?: string } | undefined> {
  const body = await res.json().catch(() => undefined);
  return body?.error;
}

async function throwOnError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const error = await readErrorBody(res);
  throw new SynthesisSetError(error?.message ?? fallback, error?.type ?? "unknown_error");
}

/** GET /api/projects/:projectId/synthesis-sets — every Synthesis Set this project owns, with rolled-up readiness. Pure read. */
export async function listSynthesisSets(backendUrl: string, knoveraToken: string, projectId: number): Promise<SynthesisSetSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load synthesis sets (${res.status}).`);
  const body = (await res.json()) as { synthesisSets: SynthesisSetSummary[] };
  return body.synthesisSets;
}

/** GET /api/projects/:projectId/synthesis-sets/:setId — full detail, including every member source and its own analysis state. Pure read. */
export async function getSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number): Promise<SynthesisSetDetail> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load synthesis set (${res.status}).`);
  return (await res.json()) as SynthesisSetDetail;
}

/**
 * POST /api/projects/:projectId/synthesis-sets — creates an empty set.
 * Never analyzes or adds any source; membership is a separate,
 * explicit follow-up call (see addSourceToSynthesisSet below).
 */
export async function createSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  name: string,
  description: string | null,
): Promise<SynthesisSetSummary> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  await throwOnError(res, `Failed to create synthesis set (${res.status}).`);
  return (await res.json()) as SynthesisSetSummary;
}

/** PATCH /api/projects/:projectId/synthesis-sets/:setId — rename and/or update the description. Membership is never touched by this call. */
export async function updateSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  update: { name?: string; description?: string | null },
): Promise<SynthesisSetSummary> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}`, {
    method: "PATCH",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  await throwOnError(res, `Failed to update synthesis set (${res.status}).`);
  return (await res.json()) as SynthesisSetSummary;
}

/** DELETE /api/projects/:projectId/synthesis-sets/:setId — deletes the set and its memberships only; never the underlying sources or their analyses. */
export async function deleteSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to delete synthesis set (${res.status}).`);
}

/**
 * POST /api/projects/:projectId/synthesis-sets/:setId/sources — adds
 * membership only. Never analyzes the source, never enqueues a job. Safe to
 * call on an already-a-member source (idempotent — returns the existing
 * membership rather than erroring).
 */
export async function addSourceToSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  sourceId: number,
): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/sources`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId }),
  });
  await throwOnError(res, `Failed to add source to synthesis set (${res.status}).`);
}

/** DELETE .../synthesis-sets/:setId/sources/:sourceId — removes membership only; never deletes the source or its analysis, never affects any other set. */
export async function removeSourceFromSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  sourceId: number,
): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/sources/${sourceId}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to remove source from synthesis set (${res.status}).`);
}

export interface BulkUpdateSynthesisSetSourcesResult {
  synthesisSetId: number;
  addedCount: number;
  ineligibleSkippedCount: number;
  removedCount: number;
}

/**
 * POST .../synthesis-sets/:setId/sources/bulk — the fine-tune editor's
 * "select all visible eligible" / "deselect all visible" actions. `add`
 * ids that aren't eligible (or don't belong to this project) are silently
 * skipped server-side (reported in ineligibleSkippedCount) — the frontend
 * never lets an ineligible row be checked in the first place, this is
 * defense-in-depth, never a partial-request error.
 */
export async function bulkUpdateSynthesisSetSources(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  update: { add?: number[]; remove?: number[] },
): Promise<BulkUpdateSynthesisSetSourcesResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/sources/bulk`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  await throwOnError(res, `Failed to update selection (${res.status}).`);
  return (await res.json()) as BulkUpdateSynthesisSetSourcesResult;
}

export interface BulkCollectionSelectionResult {
  collectionId: string;
  eligibleCount: number;
  alreadySelectedCount: number;
  addedCount: number;
  ineligibleCount: number;
}

/**
 * POST .../synthesis-sets/:setId/collections/:groupKey — "select this
 * whole collection/group": a ONE-TIME snapshot bulk-add of every CURRENTLY
 * eligible member. Never a live rule — a source imported or analyzed into
 * this group afterward never joins this set on its own; call this again
 * (or fine-tune individually) to add it.
 *
 * Phase 4L taxonomy correction — `groupKey` is the SAME opaque identity
 * listSourceCollections returns (a real collection's numeric id as a
 * string, or a "derived:..." key) — never re-derive or parse it, and
 * always pass it through encodeURIComponent since a derived key contains
 * colons.
 */
export async function bulkAddCollectionToSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  groupKey: string,
): Promise<BulkCollectionSelectionResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/collections/${encodeURIComponent(groupKey)}`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to select this collection (${res.status}).`);
  return (await res.json()) as BulkCollectionSelectionResult;
}

/** DELETE .../synthesis-sets/:setId/collections/:groupKey — removes ONLY this group's currently-selected sources from THIS set; never deletes the collection, its sources, their analyses, or membership in any other set. */
export async function bulkRemoveCollectionFromSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  groupKey: string,
): Promise<{ collectionId: string; removedCount: number }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/collections/${encodeURIComponent(groupKey)}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to remove this collection's sources (${res.status}).`);
  return (await res.json()) as { collectionId: string; removedCount: number };
}

// =============================================================================
// Pre-4M — Whop lesson membership. Mirrors the project_source membership
// functions above exactly in shape/semantics; only the underlying id space
// (lessons.id, never project_sources.id) differs. See
// backend/src/http/routes/synthesisSets.ts's own "Pre-4M" section comment.
// =============================================================================

/** POST .../synthesis-sets/:setId/lessons — adds a Whop lesson to this set. Idempotent; never analyzes, never enqueues anything. */
export async function addLessonToSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number, lessonId: number): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/lessons`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ lessonId }),
  });
  await throwOnError(res, `Failed to add lesson to synthesis set (${res.status}).`);
}

/** DELETE .../synthesis-sets/:setId/lessons/:lessonId — removes membership only; never deletes the lesson or its analysis. */
export async function removeLessonFromSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number, lessonId: number): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/lessons/${lessonId}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to remove lesson from synthesis set (${res.status}).`);
}

/** POST .../synthesis-sets/:setId/lessons/bulk — the Fine-Tune editor's "select/deselect all visible" actions applied to Whop lesson rows, mirroring bulkUpdateSynthesisSetSources. */
export async function bulkUpdateSynthesisSetLessons(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  update: { add?: number[]; remove?: number[] },
): Promise<BulkUpdateSynthesisSetSourcesResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/lessons/bulk`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  await throwOnError(res, `Failed to update lesson selection (${res.status}).`);
  return (await res.json()) as BulkUpdateSynthesisSetSourcesResult;
}

/**
 * POST .../synthesis-sets/:setId/whop-courses/:courseId — "select this
 * whole Whop course": a ONE-TIME snapshot bulk-add of every CURRENTLY
 * eligible lesson of a course fully connected to this project. Never a
 * live rule, mirrors bulkAddCollectionToSynthesisSet exactly.
 */
export async function bulkAddCourseToSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number, courseId: number): Promise<BulkCollectionSelectionResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/whop-courses/${courseId}`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to select this course (${res.status}).`);
  return (await res.json()) as BulkCollectionSelectionResult;
}

/** DELETE .../synthesis-sets/:setId/whop-courses/:courseId — removes ONLY this course's currently-selected lessons from THIS set. */
export async function bulkRemoveCourseFromSynthesisSet(backendUrl: string, knoveraToken: string, projectId: number, setId: number, courseId: number): Promise<{ courseId: number; removedCount: number }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/whop-courses/${courseId}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to remove this course's lessons (${res.status}).`);
  return (await res.json()) as { courseId: number; removedCount: number };
}

// =============================================================================
// Pre-4M — legacy Whop synthesis history. VIEW-ONLY: nothing here triggers
// a run or mutates historical data. Attachment happens only via the
// backend's recovery script (scripts/recoverLegacyWhopSynthesis.ts).
// =============================================================================

export interface LegacySynthesisRunSummary {
  runId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  createdAt: string;
  completedAt: string | null;
  model: string;
  synthesisPromptVersion: string;
  synthesizerVersion: string;
  sourceAnalysisCount: number;
  errorType: string | null;
  sanitizedError: string | null;
  hasPlaybook: boolean;
}

/** GET .../synthesis-sets/:setId/legacy-runs — every legacy synthesis_runs row attached to this set, newest first, COMPLETED and FAILED alike. Never includes the playbook JSON itself. */
export async function listLegacySynthesisRuns(backendUrl: string, knoveraToken: string, projectId: number, setId: number): Promise<LegacySynthesisRunSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/legacy-runs`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load legacy synthesis history (${res.status}).`);
  const body = (await res.json()) as { runs: LegacySynthesisRunSummary[] };
  return body.runs;
}

export interface LegacySynthesisPlaybook {
  runId: string;
  title: string;
  coreFramework: unknown;
  playbook: unknown;
  decisionFramework: unknown;
}

/** GET .../synthesis-sets/:setId/legacy-runs/:runId/playbook — the existing, immutable course_playbooks content for one attached COMPLETED legacy run. 404s for a FAILED run or one with no playbook. */
export async function getLegacySynthesisPlaybook(backendUrl: string, knoveraToken: string, projectId: number, setId: number, runId: string): Promise<LegacySynthesisPlaybook> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/legacy-runs/${runId}/playbook`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load playbook (${res.status}).`);
  return (await res.json()) as LegacySynthesisPlaybook;
}
