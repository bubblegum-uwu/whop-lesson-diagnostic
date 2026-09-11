import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import {
  createSourceCollection,
  getSourceCollectionById,
  listSourceCollectionsByProjectId,
  markCollectionSynced,
  markCollectionSyncFailed,
  deleteSourceCollection,
  type SourceCollectionRow,
} from "../../db/sourceCollectionsRepo.js";
import { createYouTubeSource } from "../../db/projectSourcesRepo.js";
import { getCatalogAnalysisStatusForSources, type CatalogAnalysisStatusEntry } from "../../db/projectSourceCatalogStatusRepo.js";
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

export interface CatalogCollectionSummary {
  id: number;
  provider: "YOUTUBE" | "DISCORD";
  externalId: string;
  title: string;
  sourceUrl: string;
  status: SourceCollectionRow["status"];
  sanitizedError: string | null;
  lastSyncedAt: Date | null;
  itemCount: number;
  analyzedCount: number;
  /** Phase 4K follow-up — true when a previous discovery/refresh pass stopped partway through this channel's upload history (hit its per-call page cap) and there are still older, undiscovered videos; Refresh will continue from where it left off. Always false for DISCORD. */
  hasMoreHistory: boolean;
}

/** Batch-computes itemCount/analyzedCount for every collection in one round trip each — never N+1 per collection (spec section 46/63). */
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
      id: collection.id,
      provider: collection.provider,
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

/** GET /api/projects/:projectId/collections — every YouTube/Discord collection this project owns, with lightweight item/analyzed counts. Never returns full analysis payloads (section 47). */
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
    const collections = await listSourceCollectionsByProjectId(deps.pool, projectId);
    res.status(200).json({ projectId, collections: await summarizeCollections(deps.pool, collections) });
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
}

/**
 * GET /api/projects/:projectId/collections/:collectionId — collection
 * metadata plus a PAGE of its items (default 50, `?cursor=`/`?limit=` —
 * spec section 46: a channel may hold hundreds of videos, this must never
 * load them all into one response). Item entries carry status only, never
 * `validated_json` (section 47) — open the existing per-source analysis
 * detail endpoint/drawer for that.
 */
export function createGetSourceCollectionHandler(deps: SourceCollectionsRouteDeps) {
  return async function getSourceCollectionHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCollection(deps.pool, req.params.projectId, req.params.collectionId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_COLLECTION);
      return;
    }
    const { collection } = resolved;

    const limit = Math.min(Math.max(Number(req.query.limit) || ITEMS_PAGE_SIZE, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const itemsResult = await deps.pool.query<{ id: string; provider: string; external_id: string; title: string | null; source_url: string; created_at: Date; total_count: string }>(
      `SELECT id, provider, external_id, title, source_url, created_at, COUNT(*) OVER () AS total_count
       FROM project_sources WHERE collection_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
      [collection.id, limit, offset],
    );
    const sourceIds = itemsResult.rows.map((r) => Number(r.id));
    const statusBySource = await getCatalogAnalysisStatusForSources(deps.pool, sourceIds);
    const totalCount = itemsResult.rows[0] ? Number(itemsResult.rows[0].total_count) : 0;

    const items: CatalogItemSummary[] = itemsResult.rows.map((row) => {
      const entry = statusBySource.get(Number(row.id)) ?? { status: "NOT_ANALYZED" as const, eligibleForSynthesis: false };
      return {
        id: Number(row.id),
        provider: row.provider as "YOUTUBE" | "DISCORD",
        externalId: row.external_id,
        title: row.title,
        sourceUrl: row.source_url,
        createdAt: row.created_at,
        status: entry.status,
        eligibleForSynthesis: entry.eligibleForSynthesis,
      };
    });

    res.status(200).json({
      collection: (await summarizeCollections(deps.pool, [collection]))[0],
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

/** DELETE /api/projects/:projectId/collections/:collectionId — removes the collection association only; every member item and its analysis history is preserved (spec section 40). */
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
