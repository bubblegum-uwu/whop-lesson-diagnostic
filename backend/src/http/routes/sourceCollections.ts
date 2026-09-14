import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { KnoveraAuthedRequest } from "../middleware/knoveraAuth.js";
import { getProjectById, type Project } from "../../db/projectsRepo.js";
import {
  createSourceCollection,
  getSourceCollectionById,
  listSourceCollectionsByProjectId,
  markCollectionSynced,
  markCollectionSyncFailed,
  deleteSourceCollection,
  type SourceCollectionRow,
} from "../../db/sourceCollectionsRepo.js";
import { createYouTubeSource, createDiscordSource, getProjectSourceById, listProjectSourceIdsByCollectionId, type ProjectSourceRow } from "../../db/projectSourcesRepo.js";
import { getContentAssetById } from "../../db/contentAssetsRepo.js";
import { getCatalogAnalysisStatusForSources, type CatalogAnalysisStatusEntry } from "../../db/projectSourceCatalogStatusRepo.js";
import { listOriginsBySourceIds, insertManualOrigin, insertDiscordChannelOrigin, type ProjectSourceOriginRow } from "../../db/projectSourceOriginsRepo.js";
import {
  listDerivedGroupsForProject,
  listDerivedGroupMemberSourceIds,
  isDerivedGroupKey,
  type DerivedGroupDescriptor,
  type DerivedGroupSourceType,
  type DerivedGroupOriginProvider,
} from "../../db/derivedSourceGroupsRepo.js";
import { toOriginSummary, type ProjectSourceOriginSummary } from "./projectSources.js";
import { parseYouTubeChannelRef, YouTubeChannelUrlParseError } from "../../lib/youtubeChannelUrl.js";
import { resolveYouTubeChannelId, YouTubeChannelResolveError } from "../../youtube/resolveYoutubeChannel.js";
import { getChannelUploadsPlaylistId, discoverYoutubeChannelVideosPage, YouTubeChannelDiscoveryError } from "../../youtube/discoverYoutubeChannelVideos.js";
import { YouTubeApiNotConfiguredError } from "../../youtube/youtubeDataApiClient.js";

export interface SourceCollectionsRouteDeps {
  pool: Pool;
  /** Phase 4K follow-up — undefined when YOUTUBE_API_KEY isn't configured; YouTube collection add/refresh routes then fail closed with a 501 (see YOUTUBE_API_NOT_CONFIGURED below) instead of silently using a permanently-limited discovery mechanism. */
  youtubeApiKey?: string;
  /** Test-only override for YOUTUBE_DISCOVERY_MAX_PAGES_PER_CALL (never set in production wiring — see http/app.ts) — lets tests exercise the page-cap/cursor-continuation behavior deterministically with a small fixture instead of a 1,000+-video one. */
  youtubeDiscoveryMaxPagesPerCall?: number;
}

const YOUTUBE_API_NOT_CONFIGURED = {
  error: { message: "YouTube channel discovery requires YOUTUBE_API_KEY to be configured on this deployment.", type: "youtube_api_not_configured" },
} as const;

const NOT_FOUND_PROJECT = { error: { message: "Unknown project.", type: "project_not_found" } } as const;
const NOT_FOUND_COLLECTION = { error: { message: "Unknown source collection.", type: "collection_not_found" } } as const;

/**
 * Phase 4K — same ownership convention as every other project-scoped
 * route in this codebase (see http/routes/synthesisSets.ts's
 * resolveOwnedSynthesisSet doc comment): the collection must exist AND
 * belong to the requested project, checked together, one deterministic
 * 404 regardless of which failed.
 *
 * PERSISTED-collection-only (a numeric collectionId) — used by the three
 * handlers below that only ever make sense for a real, mutable
 * source_collections row (add-channel discovery continuation via refresh,
 * delete). A derived group is neither refreshable nor deletable — it isn't
 * a row at all — so those routes never need to resolve one; see
 * resolveOwnedCollectionGroup below for the routes that DO need to accept
 * either kind (GET, analyze, Synthesis Set collection-selection).
 */
async function resolveOwnedCollection(pool: Pool, projectIdParam: string | string[], collectionIdParam: string | string[]) {
  const projectId = Number(projectIdParam);
  const collectionId = Number(collectionIdParam);
  if (!Number.isInteger(projectId) || !Number.isInteger(collectionId)) return null;
  const project = await getProjectById(pool, projectId);
  if (!project) return null;
  const collection = await getSourceCollectionById(pool, collectionId);
  if (!collection || collection.projectId !== projectId) return null;
  return { project, collection };
}

/**
 * Phase 4L taxonomy correction — the ONE ownership resolver every route
 * that must accept EITHER a real persisted collection OR a derived group
 * uses (GET /collections/:groupKey, POST /collections/:groupKey/analyze,
 * the Synthesis Set collection-selection routes): a plain-integer groupKey
 * resolves as a persisted collection (unchanged behavior), a
 * "derived:"-prefixed groupKey resolves via listDerivedGroupMemberSourceIds
 * — the exact same classification pass the Sources-page group list uses,
 * so a group's membership can never differ between "what the card shows"
 * and "what Analyze/Select actually acts on". Same deterministic 404 for
 * an unknown project, an unknown/foreign persisted collection, or a
 * derived groupKey with zero current members (nothing to distinguish an
 * "unknown" derived key from one that simply has no members right now —
 * both are equally not-actionable).
 */
export type ResolvedCollectionGroup =
  | { project: Project; kind: "PERSISTED"; collection: SourceCollectionRow; groupKey: string }
  | { project: Project; kind: "DERIVED"; groupKey: string; memberSourceIds: number[] };

export async function resolveOwnedCollectionGroup(
  pool: Pool,
  projectIdParam: string | string[],
  groupKeyParam: string | string[],
): Promise<ResolvedCollectionGroup | null> {
  const projectId = Number(projectIdParam);
  if (!Number.isInteger(projectId)) return null;
  const project = await getProjectById(pool, projectId);
  if (!project) return null;

  const groupKey = Array.isArray(groupKeyParam) ? groupKeyParam[0] : groupKeyParam;
  if (groupKey === undefined) return null;

  if (isDerivedGroupKey(groupKey)) {
    const memberSourceIds = await listDerivedGroupMemberSourceIds(pool, projectId, groupKey);
    if (memberSourceIds.length === 0) return null;
    return { project, kind: "DERIVED", groupKey, memberSourceIds };
  }

  const collectionId = Number(groupKey);
  if (!Number.isInteger(collectionId)) return null;
  const collection = await getSourceCollectionById(pool, collectionId);
  if (!collection || collection.projectId !== projectId) return null;
  return { project, kind: "PERSISTED", collection, groupKey: String(collection.id) };
}

/**
 * Unified read model for the Sources page's collection grid — Phase 4K's
 * persisted `source_collections` rows AND Phase 4L taxonomy correction's
 * derived groups (see derivedSourceGroupsRepo.ts) share this exact same
 * shape, so the frontend never needs two different card renderers or two
 * different "collection" concepts. `kind` distinguishes them; `groupKey` is
 * the opaque identity every other route (GET/analyze/Synthesis Set
 * selection) accepts back — never parse it client-side, and never assume
 * it's numeric.
 */
export interface CatalogCollectionSummary {
  groupKey: string;
  kind: "PERSISTED" | "DERIVED";
  /** The real source_collections.id — non-null only for a PERSISTED group. Kept alongside groupKey for any caller that still wants the raw numeric id (e.g. building a direct collection-detail link). */
  id: number | null;
  provider: "YOUTUBE" | "DISCORD" | null;
  /** The SOURCE TYPE dimension (see derivedSourceGroupsRepo.ts's doc comment) — every persisted collection is a CHANNEL (a YouTube-channel or Discord-channel connection); A_LA_CARTE and UNCLASSIFIED only ever occur for a DERIVED group. */
  sourceType: DerivedGroupSourceType;
  /** The ORIGIN/CONTAINER dimension — non-null only for a DERIVED group discovered through another provider's container (e.g. a YouTube video found via a Discord channel scan). Null for a PERSISTED collection (its own provider IS its origin) and for UNCLASSIFIED. */
  originProvider: DerivedGroupOriginProvider;
  originContainerId: string | null;
  externalId: string | null;
  title: string;
  sourceUrl: string | null;
  status: SourceCollectionRow["status"] | null;
  sanitizedError: string | null;
  lastSyncedAt: Date | null;
  itemCount: number;
  analyzedCount: number;
  /** Phase 4K follow-up — true when a previous discovery/refresh pass stopped partway through this channel's upload history (hit its per-call page cap) and there are still older, undiscovered videos; Refresh will continue from where it left off. Always false for DISCORD and for every DERIVED group. */
  hasMoreHistory: boolean;
}

/** Batch-computes itemCount/analyzedCount for every PERSISTED collection in one round trip each — never N+1 per collection (spec section 46/63). */
async function summarizeCollections(pool: Pool, collections: SourceCollectionRow[]): Promise<CatalogCollectionSummary[]> {
  if (collections.length === 0) return [];
  const collectionIds = collections.map((c) => c.id);
  const memberResult = await pool.query<{ collection_id: string; project_source_id: string }>(
    `SELECT collection_id, id AS project_source_id FROM project_sources WHERE collection_id = ANY($1)`,
    [collectionIds],
  );
  const sourceIdsByCollection = new Map<number, number[]>();
  for (const row of memberResult.rows) {
    const cid = Number(row.collection_id);
    const list = sourceIdsByCollection.get(cid) ?? [];
    list.push(Number(row.project_source_id));
    sourceIdsByCollection.set(cid, list);
  }
  const allSourceIds = memberResult.rows.map((r) => Number(r.project_source_id));
  const statusBySource = await getCatalogAnalysisStatusForSources(pool, allSourceIds);

  return collections.map((collection) => {
    const sourceIds = sourceIdsByCollection.get(collection.id) ?? [];
    const analyzedCount = sourceIds.filter((id) => statusBySource.get(id)?.eligibleForSynthesis).length;
    return {
      groupKey: String(collection.id),
      kind: "PERSISTED",
      id: collection.id,
      provider: collection.provider,
      sourceType: "CHANNEL",
      originProvider: null,
      originContainerId: null,
      externalId: collection.externalId,
      title: collection.title,
      sourceUrl: collection.sourceUrl,
      status: collection.status,
      sanitizedError: collection.sanitizedError,
      lastSyncedAt: collection.lastSyncedAt,
      itemCount: sourceIds.length,
      analyzedCount,
      hasMoreHistory: collection.discoveryCursor !== null,
    };
  });
}

/** Batch-computes itemCount/analyzedCount for every DERIVED group in one round trip — same non-N+1 guarantee as summarizeCollections above. */
async function summarizeDerivedGroups(pool: Pool, groups: DerivedGroupDescriptor[]): Promise<CatalogCollectionSummary[]> {
  if (groups.length === 0) return [];
  const allSourceIds = groups.flatMap((g) => g.memberSourceIds);
  const statusBySource = await getCatalogAnalysisStatusForSources(pool, allSourceIds);
  return groups.map((group) => {
    const analyzedCount = group.memberSourceIds.filter((id) => statusBySource.get(id)?.eligibleForSynthesis).length;
    return {
      groupKey: group.groupKey,
      kind: "DERIVED",
      id: null,
      provider: group.provider,
      sourceType: group.sourceType,
      originProvider: group.originProvider,
      originContainerId: group.originContainerId,
      externalId: null,
      title: group.title,
      sourceUrl: null,
      status: null,
      sanitizedError: null,
      lastSyncedAt: null,
      itemCount: group.memberSourceIds.length,
      analyzedCount,
      hasMoreHistory: false,
    };
  });
}

/**
 * GET /api/projects/:projectId/collections — every group this project's
 * sources fall into: real YouTube/Discord `source_collections` rows AND
 * (Phase 4L taxonomy correction) every DERIVED group with at least one
 * current member — never a flat "Uncollected"/"À-la-carte" bucket keyed
 * off `collection_id IS NULL` (see derivedSourceGroupsRepo.ts). Never
 * returns full analysis payloads (section 47).
 */
export function createListSourceCollectionsHandler(deps: SourceCollectionsRouteDeps) {
  return async function listSourceCollectionsHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }
    const [collections, derivedGroups] = await Promise.all([
      listSourceCollectionsByProjectId(deps.pool, projectId),
      listDerivedGroupsForProject(deps.pool, projectId),
    ]);
    const [persistedSummaries, derivedSummaries] = await Promise.all([
      summarizeCollections(deps.pool, collections),
      summarizeDerivedGroups(deps.pool, derivedGroups),
    ]);
    res.status(200).json({ projectId, collections: [...persistedSummaries, ...derivedSummaries] });
  };
}

const ITEMS_PAGE_SIZE = 50;

export interface CatalogItemSummary {
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  externalId: string;
  title: string | null;
  sourceUrl: string;
  createdAt: Date;
  status: CatalogAnalysisStatusEntry["status"];
  eligibleForSynthesis: boolean;
  /**
   * Phase 4L — Phase 4K-C provenance (Manual / Discord-channel-discovery
   * records), batch-loaded exactly like `statusBySource` below so a
   * collection with hundreds of items still costs one extra round trip,
   * never one per item. Always empty for DISCORD items (provenance
   * describes how a YOUTUBE video was found, never a Discord source's own
   * identity) and for a source that predates Phase 4K-C.
   */
  origins: ProjectSourceOriginSummary[];
}

interface CatalogItemDbRow {
  id: number;
  provider: string;
  external_id: string;
  title: string | null;
  source_url: string;
  created_at: Date;
}

/** Shared item-row → CatalogItemSummary assembly, batched (never N+1) regardless of whether the page's ids came from a persisted collection query or a derived group's member list. */
async function buildCatalogItems(pool: Pool, rows: CatalogItemDbRow[]): Promise<CatalogItemSummary[]> {
  const sourceIds = rows.map((r) => r.id);
  const [statusBySource, originsBySource] = await Promise.all([
    getCatalogAnalysisStatusForSources(pool, sourceIds),
    listOriginsBySourceIds(pool, sourceIds),
  ]);
  return rows.map((row) => {
    const entry = statusBySource.get(row.id) ?? { status: "NOT_ANALYZED" as const, eligibleForSynthesis: false };
    const origins = originsBySource.get(row.id) ?? [];
    return {
      id: row.id,
      provider: row.provider as "YOUTUBE" | "DISCORD",
      externalId: row.external_id,
      title: row.title,
      sourceUrl: row.source_url,
      createdAt: row.created_at,
      status: entry.status,
      eligibleForSynthesis: entry.eligibleForSynthesis,
      origins: origins.map(toOriginSummary),
    };
  });
}

/**
 * GET /api/projects/:projectId/collections/:collectionId — collection
 * metadata plus a PAGE of its items (default 50, `?cursor=`/`?limit=` —
 * spec section 46: a channel may hold hundreds of videos, this must never
 * load them all into one response). Item entries carry status only, never
 * `validated_json` (section 47) — open the existing per-source analysis
 * detail endpoint/drawer for that.
 *
 * Phase 4L taxonomy correction — `:collectionId` (kept as the route param
 * name for URL stability) now accepts either a persisted numeric id or a
 * derived groupKey (see resolveOwnedCollectionGroup). Both kinds render
 * through this exact same paginated response shape; only how the item ids
 * are resolved differs.
 */
export function createGetSourceCollectionHandler(deps: SourceCollectionsRouteDeps) {
  return async function getSourceCollectionHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCollectionGroup(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_COLLECTION);
      return;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || ITEMS_PAGE_SIZE, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    let rows: CatalogItemDbRow[];
    let totalCount: number;
    let summary: CatalogCollectionSummary;

    if (resolved.kind === "PERSISTED") {
      const itemsResult = await deps.pool.query<{
        id: string;
        provider: string;
        external_id: string;
        title: string | null;
        source_url: string;
        created_at: Date;
        total_count: string;
      }>(
        `SELECT id, provider, external_id, title, source_url, created_at, COUNT(*) OVER () AS total_count
         FROM project_sources WHERE collection_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
        [resolved.collection.id, limit, offset],
      );
      rows = itemsResult.rows.map((r) => ({ id: Number(r.id), provider: r.provider, external_id: r.external_id, title: r.title, source_url: r.source_url, created_at: r.created_at }));
      totalCount = itemsResult.rows[0] ? Number(itemsResult.rows[0].total_count) : 0;
      summary = (await summarizeCollections(deps.pool, [resolved.collection]))[0];
    } else {
      totalCount = resolved.memberSourceIds.length;
      // memberSourceIds is already ordered oldest-first (classifyDerivedGroups
      // orders by ps.created_at ASC) — slicing here is equivalent to the
      // persisted branch's ORDER BY created_at ASC LIMIT/OFFSET.
      const pageIds = resolved.memberSourceIds.slice(offset, offset + limit);
      if (pageIds.length > 0) {
        const pageResult = await deps.pool.query<{ id: string; provider: string; external_id: string; title: string | null; source_url: string; created_at: Date }>(
          `SELECT id, provider, external_id, title, source_url, created_at FROM project_sources WHERE id = ANY($1::bigint[])`,
          [pageIds],
        );
        const byId = new Map(pageResult.rows.map((r) => [Number(r.id), r]));
        rows = pageIds.map((id) => {
          const r = byId.get(id)!;
          return { id, provider: r.provider, external_id: r.external_id, title: r.title, source_url: r.source_url, created_at: r.created_at };
        });
      } else {
        rows = [];
      }
      const allGroups = await listDerivedGroupsForProject(deps.pool, resolved.project.id);
      const group = allGroups.find((g) => g.groupKey === resolved.groupKey) ?? {
        groupKey: resolved.groupKey,
        provider: null,
        sourceType: "UNCLASSIFIED" as DerivedGroupSourceType,
        originProvider: null,
        originContainerId: null,
        title: "Unclassified Sources",
        memberSourceIds: resolved.memberSourceIds,
      };
      summary = (await summarizeDerivedGroups(deps.pool, [group]))[0];
    }

    const items = await buildCatalogItems(deps.pool, rows);

    res.status(200).json({
      collection: summary,
      items,
      pagination: { limit, offset, totalCount },
    });
  };
}

interface AddYouTubeChannelBody {
  channelRef?: unknown;
}

/**
 * Phase 4K follow-up — the per-call safety bound on how many provider
 * pages (`YOUTUBE_PLAYLIST_ITEMS_PAGE_SIZE` = 50 videos each) a single
 * discovery/refresh HTTP request will walk before returning, so that
 * neither "Add Channel" nor "Refresh" can run unbounded against a
 * pathologically large channel. 20 pages = up to 1,000 videos discovered
 * in one call — comfortably covers "hundreds of videos" in a single pass.
 * A channel exceeding this depth has its remaining, older history reached
 * by subsequent Refresh calls (see discoveryCursor below) rather than by
 * this number growing without bound.
 */
export const YOUTUBE_DISCOVERY_MAX_PAGES_PER_CALL = 20;

export interface DiscoverAndImportResult {
  discoveredCount: number;
  importedCount: number;
  adoptedCount: number;
  /** Opaque cursor to persist on the collection (sourceCollectionsRepo.markCollectionSynced) — null means this pass reached the end of the channel's history (or, when earlyStopOnFullyKnownPage is set, caught up to already-known videos). */
  nextPageToken: string | null;
}

/**
 * Walks a channel's uploads playlist page by page (newest videos first,
 * exactly as YouTube orders it), importing every discovered video via
 * createYouTubeSource — which ADOPTS an already-existing à-la-carte video
 * into this collection rather than duplicating it (spec section 17) — up
 * to `maxPages` pages (default YOUTUBE_DISCOVERY_MAX_PAGES_PER_CALL) or
 * until the provider reports no further page.
 *
 * `earlyStopOnFullyKnownPage`: when true, the walk stops as soon as it
 * hits a page where EVERY video was already known (createYouTubeSource
 * returned created:false for all of them) — since the playlist is
 * newest-first, once a whole page is already-known, everything older than
 * it was necessarily seen by an earlier pass too, so continuing would only
 * re-confirm already-known videos. This is what makes a routine "check
 * for new uploads" Refresh cheap. It is NEVER used for a collection's
 * first-ever discovery pass (a video could have been added à-la-carte
 * from anywhere in the channel's history, not necessarily contiguous with
 * the newest videos, so a coincidental "fully known" page early in a
 * fresh channel's history must NOT be treated as "nothing older is new").
 *
 * Deliberately does NOT analyze anything: every imported item is a plain
 * project_source row exactly like an à-la-carte add, `status` READY,
 * never touching project_source_analysis_jobs/project_source_analyses
 * (spec section 4/57).
 */
export async function discoverAndImportYouTubeChannelPages(
  pool: Pool,
  projectId: number,
  collectionId: number,
  uploadsPlaylistId: string,
  apiKey: string,
  options: { startPageToken?: string | null; earlyStopOnFullyKnownPage: boolean; maxPages?: number },
): Promise<DiscoverAndImportResult> {
  const maxPages = options.maxPages ?? YOUTUBE_DISCOVERY_MAX_PAGES_PER_CALL;
  let pageToken = options.startPageToken ?? undefined;
  let discoveredCount = 0;
  let importedCount = 0;
  let adoptedCount = 0;
  let nextPageToken: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const result = await discoverYoutubeChannelVideosPage(uploadsPlaylistId, apiKey, pageToken ?? undefined);
    let pageImported = 0;
    for (const video of result.videos) {
      const { created } = await createYouTubeSource(pool, {
        projectId,
        externalId: video.videoId,
        sourceUrl: video.sourceUrl,
        collectionId,
        title: video.title,
      });
      discoveredCount++;
      if (created) {
        importedCount++;
        pageImported++;
      } else {
        adoptedCount++;
      }
    }

    if (options.earlyStopOnFullyKnownPage && result.videos.length > 0 && pageImported === 0) {
      nextPageToken = null;
      break;
    }
    if (!result.nextPageToken) {
      nextPageToken = null;
      break;
    }
    pageToken = result.nextPageToken;
    nextPageToken = result.nextPageToken;
  }

  return { discoveredCount, importedCount, adoptedCount, nextPageToken };
}

/**
 * POST /api/projects/:projectId/collections/youtube — Phase 4K. Resolves
 * the channel reference (URL/handle/bare id), then discovers its videos
 * via the YouTube Data API's uploads-playlist pagination (see
 * discoverYoutubeChannelVideos.ts's doc comment for why this replaced the
 * earlier RSS-feed approach, which was capped at ~15 most recent uploads).
 * Requires YOUTUBE_API_KEY — responds 501 rather than silently degrading
 * if it isn't configured.
 */
export function createAddYouTubeCollectionHandler(deps: SourceCollectionsRouteDeps) {
  return async function addYouTubeCollectionHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(NOT_FOUND_PROJECT);
      return;
    }

    if (!deps.youtubeApiKey) {
      res.status(501).json(YOUTUBE_API_NOT_CONFIGURED);
      return;
    }
    const apiKey = deps.youtubeApiKey;

    const body = req.body as AddYouTubeChannelBody;
    if (typeof body?.channelRef !== "string" || body.channelRef.trim().length === 0) {
      res.status(400).json({ error: { message: "channelRef is required.", type: "invalid_request" } });
      return;
    }

    let ref;
    try {
      ref = parseYouTubeChannelRef(body.channelRef);
    } catch (err) {
      res.status(400).json({ error: { message: err instanceof YouTubeChannelUrlParseError ? err.message : "Could not parse this YouTube channel reference.", type: "invalid_channel_ref" } });
      return;
    }

    let channelId: string;
    try {
      channelId = await resolveYouTubeChannelId(ref, apiKey);
    } catch (err) {
      if (err instanceof YouTubeApiNotConfiguredError) {
        res.status(501).json(YOUTUBE_API_NOT_CONFIGURED);
        return;
      }
      res.status(502).json({ error: { message: err instanceof YouTubeChannelResolveError ? err.message : "Could not resolve this YouTube channel.", type: "channel_resolve_failed" } });
      return;
    }

    let uploadsPlaylist;
    try {
      uploadsPlaylist = await getChannelUploadsPlaylistId(channelId, apiKey);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not look up this channel.", type: "channel_discovery_failed" } });
      return;
    }

    const { collection } = await createSourceCollection(deps.pool, {
      projectId,
      provider: "YOUTUBE",
      externalId: channelId,
      title: uploadsPlaylist.channelTitle,
      sourceUrl: `https://www.youtube.com/channel/${channelId}`,
    });

    let result: DiscoverAndImportResult;
    try {
      result = await discoverAndImportYouTubeChannelPages(deps.pool, projectId, collection.id, uploadsPlaylist.uploadsPlaylistId, apiKey, {
        earlyStopOnFullyKnownPage: false,
        maxPages: deps.youtubeDiscoveryMaxPagesPerCall,
      });
    } catch (err) {
      const message = err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not discover this channel's videos.";
      await markCollectionSyncFailed(deps.pool, collection.id, message);
      res.status(502).json({ error: { message, type: "channel_discovery_failed" } });
      return;
    }

    await markCollectionSynced(deps.pool, collection.id, uploadsPlaylist.channelTitle, result.nextPageToken);

    const refreshedCollection = await getSourceCollectionById(deps.pool, collection.id);
    res.status(201).json({
      collection: (await summarizeCollections(deps.pool, [refreshedCollection!]))[0],
      discoveredCount: result.discoveredCount,
      importedCount: result.importedCount,
      adoptedCount: result.adoptedCount,
      hasMoreHistory: result.nextPageToken !== null,
    });
  };
}

/**
 * POST /api/projects/:projectId/collections/:collectionId/refresh —
 * Phase 4K. Re-runs discovery for a YouTube collection. Adaptive cursor
 * behavior (see the migration's discoveryCursor doc comment):
 *   - If a previous pass left older history undiscovered (discoveryCursor
 *     is set), this call CONTINUES from that cursor, walking deeper into
 *     the channel's history rather than restarting at the newest video —
 *     this is what eventually reaches a channel's full catalog across
 *     repeated refreshes for a channel bigger than one pass can cover.
 *   - Otherwise (fully caught up already) this checks the FRONT of the
 *     playlist for new uploads since the last pass, stopping as soon as a
 *     page is entirely already-known (see discoverAndImportYouTubeChannelPages's
 *     earlyStopOnFullyKnownPage doc comment) — cheap and idempotent.
 * Either way: newly-seen videos are imported (never analyzed — section
 * 4/25), already-known videos are left completely untouched (their
 * project_sources row, and therefore every analysis attached to it, is
 * never modified — section 26/51). No refresh mechanism exists for
 * Discord collections (none can be created today — see the PR
 * description's Discord section), so this 400s for any non-YOUTUBE
 * collection rather than silently no-op'ing.
 */
export function createRefreshSourceCollectionHandler(deps: SourceCollectionsRouteDeps) {
  return async function refreshSourceCollectionHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCollection(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_COLLECTION);
      return;
    }
    const { project, collection } = resolved;

    if (collection.provider !== "YOUTUBE") {
      res.status(400).json({ error: { message: "Refresh is only supported for YouTube collections today.", type: "refresh_not_supported" } });
      return;
    }
    if (!deps.youtubeApiKey) {
      res.status(501).json(YOUTUBE_API_NOT_CONFIGURED);
      return;
    }
    const apiKey = deps.youtubeApiKey;

    let uploadsPlaylist;
    try {
      uploadsPlaylist = await getChannelUploadsPlaylistId(collection.externalId, apiKey);
    } catch (err) {
      const message = err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not refresh this channel.";
      await markCollectionSyncFailed(deps.pool, collection.id, message);
      res.status(502).json({ error: { message, type: "channel_discovery_failed" } });
      return;
    }

    const hadPendingHistory = collection.discoveryCursor !== null;
    let result: DiscoverAndImportResult;
    try {
      result = await discoverAndImportYouTubeChannelPages(deps.pool, project.id, collection.id, uploadsPlaylist.uploadsPlaylistId, apiKey, {
        startPageToken: hadPendingHistory ? collection.discoveryCursor : undefined,
        earlyStopOnFullyKnownPage: !hadPendingHistory,
        maxPages: deps.youtubeDiscoveryMaxPagesPerCall,
      });
    } catch (err) {
      const message = err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not refresh this channel.";
      await markCollectionSyncFailed(deps.pool, collection.id, message);
      res.status(502).json({ error: { message, type: "channel_discovery_failed" } });
      return;
    }

    await markCollectionSynced(deps.pool, collection.id, uploadsPlaylist.channelTitle, result.nextPageToken);

    const refreshedCollection = await getSourceCollectionById(deps.pool, collection.id);
    res.status(200).json({
      collection: (await summarizeCollections(deps.pool, [refreshedCollection!]))[0],
      discoveredCount: result.discoveredCount,
      importedCount: result.importedCount,
      adoptedCount: result.adoptedCount,
      hasMoreHistory: result.nextPageToken !== null,
    });
  };
}

/** DELETE /api/projects/:projectId/collections/:collectionId — removes the collection association only; every member item and its analysis history is preserved (spec section 40). PERSISTED-only — a derived group has no row to delete; its members simply stay classified the same way until their real provenance changes. */
export function createDeleteSourceCollectionHandler(deps: SourceCollectionsRouteDeps) {
  return async function deleteSourceCollectionHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCollection(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_COLLECTION);
      return;
    }
    await deleteSourceCollection(deps.pool, resolved.collection.id);
    res.status(204).end();
  };
}

const MAX_ADD_COLLECTION_TO_PROJECT_TARGETS = 20;

export type AddCollectionToProjectTargetKind = "invalid" | "ok";
export interface AddCollectionToProjectTargetResult {
  targetProjectId: number;
  kind: AddCollectionToProjectTargetKind;
  addedCount: number;
  alreadyPresentCount: number;
  failedCount: number;
}
export interface AddCollectionToProjectResponse {
  groupKey: string;
  memberCount: number;
  results: AddCollectionToProjectTargetResult[];
}

/**
 * Copies ONE member source into `targetProjectId`, preserving provenance
 * so the SAME canonical group (persisted or derived) resolves in the
 * destination — never flattened into Manual/À-la-carte. Reuses the exact
 * cross-project identity/dedup rules `createAddProjectSourceToProjectsHandler`
 * already established for a single Discord source (spec section
 * 40-51): YouTube has no shared-asset layer (its URL is durable/free to
 * reconstruct) so a plain createYouTubeSource upsert is enough; Discord
 * MUST go through the shared content_assets layer, asset-ownership-checked,
 * so durable bytes are reused rather than re-downloaded or duplicated.
 * `targetCollectionId` is non-null only when copying a PERSISTED
 * collection's member (see the caller) — a derived group's member gets no
 * collection_id in the destination, exactly like the source project;
 * origins copied below are what let the SAME derived group re-form there.
 * Never touches project_source_analyses/project_source_analysis_jobs/
 * synthesis_set_sources — this is content availability only.
 */
async function copyMemberSourceToProject(
  pool: Pool,
  source: ProjectSourceRow,
  origins: ProjectSourceOriginRow[],
  targetProjectId: number,
  targetCollectionId: number | null,
  requesterIdentity: string,
): Promise<"added" | "already_present" | "failed"> {
  if (source.provider === "YOUTUBE") {
    const { source: targetSource, created } = await createYouTubeSource(pool, {
      projectId: targetProjectId,
      externalId: source.externalId,
      sourceUrl: source.sourceUrl,
      collectionId: targetCollectionId,
      title: source.title,
    });
    // Copied regardless of `created` — idempotent enrichment either way
    // (insertManualOrigin/insertDiscordChannelOrigin never duplicate), so
    // a target that already had this source (added-and-later-reclassified)
    // still picks up any provenance it was missing.
    for (const origin of origins) {
      if (origin.originType === "MANUAL") {
        await insertManualOrigin(pool, targetSource.id);
      } else if (origin.originType === "DISCORD_CHANNEL" && origin.discordChannelId && origin.discordMessageId && origin.discordPostedAt) {
        await insertDiscordChannelOrigin(pool, {
          projectSourceId: targetSource.id,
          guildId: origin.discordGuildId ?? "",
          channelId: origin.discordChannelId,
          channelName: origin.discordChannelName,
          messageId: origin.discordMessageId,
          messageUrl: origin.discordMessageUrl,
          postedAt: origin.discordPostedAt,
        });
      }
    }
    return created ? "added" : "already_present";
  }

  // DISCORD — durable bytes live in content_assets, shared by (owner_identity, provider, external_id) across every project; see contentAssetsRepo.ts.
  if (source.contentAssetId == null) return "failed";
  const asset = await getContentAssetById(pool, source.contentAssetId);
  if (!asset || asset.ownerIdentity !== requesterIdentity) return "failed";
  const { created } = await createDiscordSource(pool, {
    projectId: targetProjectId,
    ownerIdentity: asset.ownerIdentity,
    externalId: source.externalId,
    sourceUrl: source.sourceUrl,
    collectionId: targetCollectionId,
    title: source.title,
  });
  return created ? "added" : "already_present";
}

/**
 * POST /api/projects/:projectId/collections/:collectionId/add-to-project —
 * "Add Collection to Project": a ONE-TIME SNAPSHOT copy of every CURRENT
 * member of this collection/group into one or more other projects (spec:
 * never a live/ongoing sync — a source added to the SOURCE collection
 * afterward never appears in the destination on its own; re-run this
 * action to add anything newly missing). Works identically for a
 * PERSISTED collection (YouTube/Discord channel) and a DERIVED group
 * (YouTube-via-Discord-channel, YouTube à-la-carte, Unclassified) — both
 * resolve via resolveOwnedCollectionGroup, the SAME resolver Analyze
 * Collection and Synthesis Set selection already share.
 *
 * Idempotent per target: re-running this against a destination that
 * already has some/all members reports those as `alreadyPresentCount`,
 * never a duplicate row — createYouTubeSource/createDiscordSource's own
 * ON CONFLICT upserts are the actual dedup guarantee (by (project_id,
 * provider, external_id)), never an application-level check-then-insert.
 *
 * Deliberately never: analyzes anything, copies analysis jobs/results,
 * selects anything into a Synthesis Set, or triggers synthesis — the
 * destination project's own sources follow its own normal analysis rules
 * from a totally unanalyzed state, exactly like any other newly-added
 * source (this matters most for GENERAL_KNOWLEDGE → TRADING_STRATEGIES,
 * where the content becomes available but nothing about it is implied
 * "already reviewed").
 */
export function createAddCollectionToProjectHandler(deps: SourceCollectionsRouteDeps) {
  return async function addCollectionToProjectHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCollectionGroup(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_COLLECTION);
      return;
    }

    const body = req.body as { targetProjectIds?: unknown };
    if (!Array.isArray(body?.targetProjectIds) || body.targetProjectIds.length === 0) {
      res.status(400).json({ error: { message: "targetProjectIds is required.", type: "invalid_request" } });
      return;
    }
    if (body.targetProjectIds.length > MAX_ADD_COLLECTION_TO_PROJECT_TARGETS) {
      res.status(400).json({ error: { message: `At most ${MAX_ADD_COLLECTION_TO_PROJECT_TARGETS} target projects per request.`, type: "invalid_request" } });
      return;
    }

    const requesterIdentity = (req as KnoveraAuthedRequest).knoveraOperator!;

    const memberIds = resolved.kind === "PERSISTED" ? await listProjectSourceIdsByCollectionId(deps.pool, resolved.collection.id) : resolved.memberSourceIds;
    const [memberSources, originsBySource] = await Promise.all([
      Promise.all(memberIds.map((id) => getProjectSourceById(deps.pool, id))),
      listOriginsBySourceIds(deps.pool, memberIds),
    ]);
    const members = memberSources.filter((s): s is NonNullable<typeof s> => s !== null);

    const results: AddCollectionToProjectTargetResult[] = [];
    for (const rawTargetProjectId of body.targetProjectIds) {
      const targetProjectId = Number(rawTargetProjectId);
      if (!Number.isInteger(targetProjectId) || targetProjectId === resolved.project.id) {
        results.push({ targetProjectId: Number.isFinite(targetProjectId) ? targetProjectId : -1, kind: "invalid", addedCount: 0, alreadyPresentCount: 0, failedCount: 0 });
        continue;
      }
      const targetProject = await getProjectById(deps.pool, targetProjectId);
      if (!targetProject) {
        results.push({ targetProjectId, kind: "invalid", addedCount: 0, alreadyPresentCount: 0, failedCount: 0 });
        continue;
      }

      // The destination's PERSISTED collection row (same provider+externalId
      // identity, create-or-reuse) is resolved ONCE per target, never per
      // member — mirrors createAddProjectSourceToProjectsHandler's
      // `originalCollection` pattern. A DERIVED group never gets a
      // fabricated source_collections row here — its identity re-forms
      // from the copied origins alone (the taxonomy correction's own rule:
      // never force a derived grouping into source_collections).
      let targetCollectionId: number | null = null;
      if (resolved.kind === "PERSISTED") {
        const { collection } = await createSourceCollection(deps.pool, {
          projectId: targetProjectId,
          provider: resolved.collection.provider,
          externalId: resolved.collection.externalId,
          title: resolved.collection.title,
          sourceUrl: resolved.collection.sourceUrl,
        });
        targetCollectionId = collection.id;
      }

      let addedCount = 0;
      let alreadyPresentCount = 0;
      let failedCount = 0;
      for (const source of members) {
        const outcome = await copyMemberSourceToProject(deps.pool, source, originsBySource.get(source.id) ?? [], targetProjectId, targetCollectionId, requesterIdentity);
        if (outcome === "added") addedCount++;
        else if (outcome === "already_present") alreadyPresentCount++;
        else failedCount++;
      }
      results.push({ targetProjectId, kind: "ok", addedCount, alreadyPresentCount, failedCount });
    }

    const response: AddCollectionToProjectResponse = { groupKey: resolved.groupKey, memberCount: members.length, results };
    res.status(200).json(response);
  };
}
