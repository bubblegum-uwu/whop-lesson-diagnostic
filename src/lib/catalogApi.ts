/**
 * Phase 4K — clients for the new source-collection catalog endpoints
 * (YouTube channels, multi-course Whop, bulk à-la-carte import, batch
 * analyze). Same Knovera-session-token convention as sourcesApi.ts — never
 * a Whop token for these, except implicitly server-side for the Whop
 * course-connect/refresh calls (this client never sees or handles that).
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

async function readErrorMessage(res: Response, fallback: string): Promise<{ message: string; type: string }> {
  const body = await res.json().catch(() => undefined);
  return { message: body?.error?.message ?? fallback, type: body?.error?.type ?? "unknown_error" };
}

export class CatalogApiError extends Error {
  type: string;
  constructor(message: string, type: string) {
    super(message);
    this.name = "CatalogApiError";
    this.type = type;
  }
}

async function throwOnError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const { message, type } = await readErrorMessage(res, fallback);
  throw new CatalogApiError(message, type);
}

export type CollectionStatus = "READY" | "SYNCING" | "SYNC_FAILED";

export interface CatalogCollectionSummary {
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  externalId: string;
  title: string;
  sourceUrl: string;
  status: CollectionStatus;
  sanitizedError: string | null;
  lastSyncedAt: string | null;
  itemCount: number;
  analyzedCount: number;
  /** Phase 4K follow-up — true when this channel's upload history is bigger than one discovery pass can cover; Refresh continues deeper into it rather than restarting at the newest video. */
  hasMoreHistory: boolean;
}

export type CatalogItemStatus = "NOT_ANALYZED" | "QUEUED" | "ANALYZING" | "VALIDATING" | "ANALYZED" | "FAILED" | "CANCELLED";

export interface CatalogItemSummary {
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  externalId: string;
  title: string | null;
  sourceUrl: string;
  createdAt: string;
  status: CatalogItemStatus;
  eligibleForSynthesis: boolean;
}

export interface CatalogPagination {
  limit: number;
  offset: number;
  totalCount: number;
}

/** GET /api/projects/:projectId/collections */
export async function listSourceCollections(backendUrl: string, knoveraToken: string, projectId: number): Promise<CatalogCollectionSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load collections (${res.status}).`);
  const body = (await res.json()) as { collections: CatalogCollectionSummary[] };
  return body.collections;
}

/** GET /api/projects/:projectId/collections/:collectionId */
export async function getSourceCollection(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  collectionId: number,
  page: { limit?: number; offset?: number } = {},
): Promise<{ collection: CatalogCollectionSummary; items: CatalogItemSummary[]; pagination: CatalogPagination }> {
  const params = new URLSearchParams();
  if (page.limit != null) params.set("limit", String(page.limit));
  if (page.offset != null) params.set("offset", String(page.offset));
  const qs = params.toString();
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/${collectionId}${qs ? `?${qs}` : ""}`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load collection (${res.status}).`);
  return (await res.json()) as { collection: CatalogCollectionSummary; items: CatalogItemSummary[]; pagination: CatalogPagination };
}

/** POST /api/projects/:projectId/collections/youtube */
export async function addYouTubeCollection(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  channelRef: string,
): Promise<{ collection: CatalogCollectionSummary; discoveredCount: number; importedCount: number; adoptedCount: number; hasMoreHistory: boolean }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/youtube`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ channelRef }),
  });
  await throwOnError(res, `Failed to add YouTube channel (${res.status}).`);
  return await res.json();
}

/** POST /api/projects/:projectId/collections/:collectionId/refresh */
export async function refreshSourceCollection(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  collectionId: number,
): Promise<{ collection: CatalogCollectionSummary; discoveredCount: number; importedCount: number; adoptedCount: number; hasMoreHistory: boolean }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/${collectionId}/refresh`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to refresh collection (${res.status}).`);
  return await res.json();
}

/** DELETE /api/projects/:projectId/collections/:collectionId — removes the collection association only; items are preserved. */
export async function deleteSourceCollection(backendUrl: string, knoveraToken: string, projectId: number, collectionId: number): Promise<void> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/${collectionId}`, { method: "DELETE", headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to remove collection (${res.status}).`);
}

export interface BatchImportResultEntry {
  url: string;
  kind: "added" | "duplicate" | "invalid";
  message?: string;
}
export interface BatchImportResponse {
  results: BatchImportResultEntry[];
  addedCount: number;
  duplicateCount: number;
  invalidCount: number;
}

/** POST /api/projects/:projectId/sources/youtube/batch */
export async function batchAddYouTubeSources(backendUrl: string, knoveraToken: string, projectId: number, urls: string[]): Promise<BatchImportResponse> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/youtube/batch`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  await throwOnError(res, `Failed to import YouTube videos (${res.status}).`);
  return await res.json();
}

/** POST /api/projects/:projectId/sources/discord/batch */
export async function batchAddDiscordSources(backendUrl: string, knoveraToken: string, projectId: number, urls: string[]): Promise<BatchImportResponse> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/discord/batch`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  await throwOnError(res, `Failed to import Discord attachments (${res.status}).`);
  return await res.json();
}

export type BatchAnalyzeResultKind = "queued" | "already_queued" | "skipped" | "not_found" | "not_analyzable";
export interface BatchAnalyzeResultEntry {
  sourceId: number;
  kind: BatchAnalyzeResultKind;
}

/** POST /api/projects/:projectId/sources/analyze-batch — explicit "Analyze Selected." */
export async function batchAnalyzeProjectSources(backendUrl: string, knoveraToken: string, projectId: number, sourceIds: number[]): Promise<{ results: BatchAnalyzeResultEntry[] }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/analyze-batch`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ sourceIds }),
  });
  await throwOnError(res, `Failed to start batch analysis (${res.status}).`);
  return await res.json();
}

export interface WhopCourseSummary {
  provider: "WHOP";
  sourceType: "COURSE";
  courseId: number;
  externalId: string;
  name: string;
  lessonCount: number;
  analyzedLessonCount: number;
  queuedCount: number;
  processingCount: number;
  failedCount: number;
  remainingCount: number;
  lastSyncedAt: string | null;
  totalCost: number | null;
}

/** GET /api/projects/:projectId/whop-courses */
export async function listWhopCourses(backendUrl: string, knoveraToken: string, projectId: number): Promise<WhopCourseSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-courses`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load Whop courses (${res.status}).`);
  const body = (await res.json()) as { courses: WhopCourseSummary[] };
  return body.courses;
}

/** POST /api/projects/:projectId/whop-courses */
export async function connectWhopCourse(backendUrl: string, knoveraToken: string, projectId: number, courseUrl: string): Promise<{ course: WhopCourseSummary }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-courses`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ courseUrl }),
  });
  await throwOnError(res, `Failed to connect Whop course (${res.status}).`);
  return await res.json();
}

/** POST /api/projects/:projectId/whop-courses/:courseId/refresh */
export async function refreshWhopCourse(backendUrl: string, knoveraToken: string, projectId: number, courseId: number): Promise<{ course: WhopCourseSummary }> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-courses/${courseId}/refresh`, { method: "POST", headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to refresh Whop course (${res.status}).`);
  return await res.json();
}

export interface WhopLessonItemSummary {
  id: number;
  title: string;
  chapterTitle: string | null;
  sourceUrl: string;
  durationSeconds: number | null;
  status: CatalogItemStatus;
  eligibleForSynthesis: boolean;
}

export interface WhopLessonBatchResultEntry {
  url: string;
  kind: "added" | "duplicate" | "invalid";
  lesson?: { id: number; title: string; courseId: number; courseTitle: string; sourceUrl: string };
  message?: string;
}
export interface WhopLessonBatchResponse {
  results: WhopLessonBatchResultEntry[];
  addedCount: number;
  duplicateCount: number;
  invalidCount: number;
}

/**
 * POST /api/projects/:projectId/whop-lessons/batch — Phase 4K follow-up.
 * à-la-carte Whop lesson import: each URL is validated/resolved
 * independently (the underlying course is synced once per distinct
 * course, never once per URL), never analyzes anything.
 */
export async function batchAddWhopLessons(backendUrl: string, knoveraToken: string, projectId: number, urls: string[]): Promise<WhopLessonBatchResponse> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-lessons/batch`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  await throwOnError(res, `Failed to import Whop lessons (${res.status}).`);
  return await res.json();
}

/** GET /api/projects/:projectId/whop-courses/:courseId/lessons */
export async function listWhopCourseLessons(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  courseId: number,
  page: { limit?: number; offset?: number } = {},
): Promise<{ course: WhopCourseSummary; items: WhopLessonItemSummary[]; pagination: CatalogPagination }> {
  const params = new URLSearchParams();
  if (page.limit != null) params.set("limit", String(page.limit));
  if (page.offset != null) params.set("offset", String(page.offset));
  const qs = params.toString();
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-courses/${courseId}/lessons${qs ? `?${qs}` : ""}`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load course lessons (${res.status}).`);
  return await res.json();
}
