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

export interface SynthesisSetDetail extends SynthesisSetSummary {
  sources: SynthesisSetMemberSource[];
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
  collectionId: number;
  eligibleCount: number;
  alreadySelectedCount: number;
  addedCount: number;
  ineligibleCount: number;
}

/**
 * POST .../synthesis-sets/:setId/collections/:collectionId — "select this
 * whole collection": a ONE-TIME snapshot bulk-add of every CURRENTLY
 * eligible member. Never a live rule — a source imported or analyzed into
 * this collection afterward never joins this set on its own; call this
 * again (or fine-tune individually) to add it.
 */
export async function bulkAddCollectionToSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  collectionId: number,
): Promise<BulkCollectionSelectionResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/collections/${collectionId}`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to select this collection (${res.status}).`);
  return (await res.json()) as BulkCollectionSelectionResult;
}

/** DELETE .../synthesis-sets/:setId/collections/:collectionId — removes ONLY this collection's currently-selected sources from THIS set; never deletes the collection, its sources, their analyses, or membership in any other set. */
export async function bulkRemoveCollectionFromSynthesisSet(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  setId: number,
  collectionId: number,
): Promise<{ collectionId: number; removedCount: number }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/synthesis-sets/${setId}/collections/${collectionId}`, {
    method: "DELETE",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to remove this collection's sources (${res.status}).`);
  return (await res.json()) as { collectionId: number; removedCount: number };
}
