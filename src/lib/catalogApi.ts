/**
 * Phase 4K — clients for the new source-collection catalog endpoints
 * (YouTube channels, multi-course Whop, bulk à-la-carte import, batch
 * analyze). Same Knovera-session-token convention as sourcesApi.ts — never
 * a Whop token for these, except implicitly server-side for the Whop
 * course-connect/refresh calls (this client never sees or handles that).
 */
import type { YouTubeProjectSource, ProjectSourceOriginSummary } from "./sourcesApi";
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

/** The SOURCE TYPE dimension (Phase 4L taxonomy correction) — see backend derivedSourceGroupsRepo.ts's doc comment for the full provider/type/origin model. Every PERSISTED collection is CHANNEL; A_LA_CARTE and UNCLASSIFIED only ever occur on a DERIVED group. */
export type CatalogGroupSourceType = "CHANNEL" | "A_LA_CARTE" | "UNCLASSIFIED";
export type CatalogGroupOriginProvider = "DISCORD" | "MANUAL" | null;

/**
 * A row in the Sources page's collection grid — either a real, persisted
 * YouTube/Discord `source_collections` row (`kind: "PERSISTED"`) or a
 * DERIVED group computed from provenance data with no collection row of
 * its own (`kind: "DERIVED"`) — e.g. YouTube videos discovered by scanning
 * a Discord channel, which must group by that Discord channel rather than
 * fall into a generic "à-la-carte" bucket. Both kinds render through this
 * one shape and are both addressed via `groupKey` everywhere else (GET
 * collection detail, Analyze Collection, Synthesis Set group-selection) —
 * never assume `groupKey` is numeric, and never parse it; pass it through
 * verbatim (URL-encoded, since a derived key contains colons).
 */
export interface CatalogCollectionSummary {
  groupKey: string;
  kind: "PERSISTED" | "DERIVED";
  /** The real source_collections.id — non-null only for a PERSISTED group. */
  id: number | null;
  provider: "YOUTUBE" | "DISCORD" | null;
  sourceType: CatalogGroupSourceType;
  originProvider: CatalogGroupOriginProvider;
  originContainerId: string | null;
  externalId: string | null;
  title: string;
  sourceUrl: string | null;
  status: CollectionStatus | null;
  sanitizedError: string | null;
  lastSyncedAt: string | null;
  itemCount: number;
  analyzedCount: number;
  /** Phase 4K follow-up — true when this channel's upload history is bigger than one discovery pass can cover; Refresh continues deeper into it rather than restarting at the newest video. Always false for a DERIVED group. */
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
  /** Phase 4L — Phase 4K-C provenance, batch-loaded server-side; always empty for DISCORD items or a source that predates Phase 4K-C. */
  origins: ProjectSourceOriginSummary[];
}

export interface CatalogPagination {
  limit: number;
  offset: number;
  totalCount: number;
}

/** "YOUTUBE · CHANNEL" / "DISCORD · CHANNEL" / "YOUTUBE · À-LA-CARTE" / "OTHER · UNCLASSIFIED" — the PROVIDER + SOURCE TYPE line every collection/group card and detail page header shows (Phase 4L taxonomy correction's two-dimension model; see CatalogCollectionSummary's doc comment). */
export function catalogGroupTypeLabel(c: Pick<CatalogCollectionSummary, "provider" | "sourceType">): string {
  const providerLabel = c.provider ?? "OTHER";
  const typeLabel = c.sourceType === "A_LA_CARTE" ? "À-LA-CARTE" : c.sourceType;
  return `${providerLabel} · ${typeLabel}`;
}

/** The ORIGIN/CONTAINER subtitle line — e.g. "Discord · #scarface-alerts", "YouTube · TraderTV", "Manual YouTube", "Unclassified Sources". A DERIVED group's `title` already comes fully composed from the backend; a PERSISTED collection's `title` is just its raw channel/collection name, so this prefixes it with its own provider label for the same "<origin> · <container>" shape every card uses. */
export function catalogGroupOriginLine(c: Pick<CatalogCollectionSummary, "kind" | "provider" | "title">): string {
  if (c.kind === "PERSISTED") {
    const providerLabel = c.provider === "YOUTUBE" ? "YouTube" : "Discord";
    return `${providerLabel} · ${c.title}`;
  }
  return c.title;
}

/** GET /api/projects/:projectId/collections */
export async function listSourceCollections(backendUrl: string, knoveraToken: string, projectId: number): Promise<CatalogCollectionSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load collections (${res.status}).`);
  const body = (await res.json()) as { collections: CatalogCollectionSummary[] };
  return body.collections;
}

/** GET /api/projects/:projectId/collections/:groupKey — `groupKey` is the opaque identity from CatalogCollectionSummary.groupKey (a persisted collection's numeric id as a string, or a "derived:..." key); always URL-encoded here since a derived key contains colons. */
export async function getSourceCollection(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  groupKey: string,
  page: { limit?: number; offset?: number } = {},
): Promise<{ collection: CatalogCollectionSummary; items: CatalogItemSummary[]; pagination: CatalogPagination }> {
  const params = new URLSearchParams();
  if (page.limit != null) params.set("limit", String(page.limit));
  if (page.offset != null) params.set("offset", String(page.offset));
  const qs = params.toString();
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/${encodeURIComponent(groupKey)}${qs ? `?${qs}` : ""}`, { headers: authHeaders(knoveraToken) });
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

export interface AnalyzeCollectionResult {
  queued: number;
  alreadyAnalyzed: number;
  alreadyQueued: number;
  processing: number;
  failed: number;
}

/**
 * POST /api/projects/:projectId/collections/:groupKey/analyze — Phase
 * 4L's "Analyze Collection"/"Analyze N Remaining." The backend resolves
 * the group's members itself (never a client-enumerated id list), so this
 * works regardless of how many items the group holds and works identically
 * for a PERSISTED collection or a DERIVED group — see
 * CatalogCollectionSummary's doc comment. Never touches Synthesis Set
 * membership.
 */
export async function analyzeCollection(backendUrl: string, knoveraToken: string, projectId: number, groupKey: string): Promise<AnalyzeCollectionResult> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/collections/${encodeURIComponent(groupKey)}/analyze`, {
    method: "POST",
    headers: authHeaders(knoveraToken),
  });
  await throwOnError(res, `Failed to analyze this collection (${res.status}).`);
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

export interface AlaCarteWhopLessonSummary {
  id: number;
  title: string;
  courseId: number;
  courseTitle: string;
  sourceUrl: string;
  durationSeconds: number | null;
  status: CatalogItemStatus;
  eligibleForSynthesis: boolean;
}

/**
 * GET /api/projects/:projectId/whop-lessons — this project's à-la-carte
 * Whop lessons ONLY (never a connected course's full lesson list — see
 * listWhopCourseLessons above for that, a genuinely different concept).
 */
export async function listAlaCarteWhopLessons(backendUrl: string, knoveraToken: string, projectId: number): Promise<AlaCarteWhopLessonSummary[]> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/whop-lessons`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load à-la-carte Whop lessons (${res.status}).`);
  const body = (await res.json()) as { items: AlaCarteWhopLessonSummary[] };
  return body.items;
}

export interface DiscordImportChannelInput {
  guildId: string;
  channelId: string;
  channelName: string | null;
}

export interface DiscordImportOccurrenceInput {
  youtubeUrl: string;
  messageId: string;
  messageUrl: string | null;
  /** ISO-8601 — the Discord MESSAGE's timestamp, never a scan/import time. */
  postedAt: string;
}

export type DiscordImportResultKind = "added" | "existing_source_new_origin" | "existing_origin_enriched" | "duplicate_origin" | "invalid";
export interface DiscordImportResultEntry {
  youtubeUrl: string;
  messageId: string;
  kind: DiscordImportResultKind;
  source?: YouTubeProjectSource;
  message?: string;
}
export interface DiscordImportResponse {
  results: DiscordImportResultEntry[];
  occurrencesProcessed: number;
  newSourceCount: number;
  newOriginCount: number;
  /** A previously-recorded Discord occurrence whose channel name and/or message URL was missing and just got filled in — never a duplicate row, never an overwritten trustworthy value (see the backend's insertDiscordChannelOrigin doc comment). */
  enrichedOriginCount: number;
  duplicateOriginCount: number;
  invalidCount: number;
}

/**
 * POST /api/projects/:projectId/sources/youtube/discord-import — Phase
 * 4K-C. Commits the browser companion's scan results (already extracted
 * client-side; this call sends them to the backend, which re-validates and
 * re-canonicalizes every URL — see the backend route's own doc comment).
 * Never analyzes anything.
 */
export async function importYouTubeSourcesFromDiscordChannel(
  backendUrl: string,
  knoveraToken: string,
  projectId: number,
  channel: DiscordImportChannelInput,
  occurrences: DiscordImportOccurrenceInput[],
): Promise<DiscordImportResponse> {
  const res = await fetch(`${backendUrl}/api/projects/${projectId}/sources/youtube/discord-import`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ channel, occurrences }),
  });
  await throwOnError(res, `Failed to import YouTube videos from Discord (${res.status}).`);
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
