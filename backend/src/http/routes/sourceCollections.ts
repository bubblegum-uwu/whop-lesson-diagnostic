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
import { discoverYoutubeChannelVideos, YouTubeChannelDiscoveryError } from "../../youtube/discoverYoutubeChannelVideos.js";

export interface SourceCollectionsRouteDeps {
  pool: Pool;
}

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
 * POST /api/projects/:projectId/collections/youtube — Phase 4K. Resolves
 * the channel reference (URL/handle/bare id), discovers its videos via
 * the official RSS feed (see discoverYoutubeChannelVideos.ts's doc
 * comment for the ~15-most-recent-uploads limitation), creates/reuses the
 * collection row, and imports every discovered video via
 * createYouTubeSource — which ADOPTS an already-existing à-la-carte video
 * into this collection rather than duplicating it (spec section 17).
 *
 * Deliberately does NOT analyze anything: every imported item is a plain
 * project_source row exactly like an à-la-carte add, `status` READY,
 * never touching project_source_analysis_jobs/project_source_analyses
 * (spec section 4/57).
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
      channelId = await resolveYouTubeChannelId(ref);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof YouTubeChannelResolveError ? err.message : "Could not resolve this YouTube channel.", type: "channel_resolve_failed" } });
      return;
    }

    let discovery;
    try {
      discovery = await discoverYoutubeChannelVideos(channelId);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not discover this channel's videos.", type: "channel_discovery_failed" } });
      return;
    }

    const { collection } = await createSourceCollection(deps.pool, {
      projectId,
      provider: "YOUTUBE",
      externalId: channelId,
      title: discovery.channelTitle,
      sourceUrl: `https://www.youtube.com/channel/${channelId}`,
    });
    await markCollectionSynced(deps.pool, collection.id, discovery.channelTitle);

    let importedCount = 0;
    let adoptedCount = 0;
    for (const video of discovery.videos) {
      const { created } = await createYouTubeSource(deps.pool, {
        projectId,
        externalId: video.videoId,
        sourceUrl: video.sourceUrl,
        collectionId: collection.id,
        title: video.title,
      });
      if (created) importedCount++;
      else adoptedCount++;
    }

    const refreshedCollection = await getSourceCollectionById(deps.pool, collection.id);
    res.status(201).json({
      collection: (await summarizeCollections(deps.pool, [refreshedCollection!]))[0],
      discoveredCount: discovery.videos.length,
      importedCount,
      adoptedCount,
    });
  };
}

/**
 * POST /api/projects/:projectId/collections/:collectionId/refresh —
 * Phase 4K. Re-runs discovery for a YouTube collection: newly-seen videos
 * are imported (never analyzed — section 4/25), already-known videos are
 * left completely untouched (their project_sources row, and therefore
 * every analysis attached to it, is never modified — section 26/51). No
 * refresh mechanism exists for Discord collections (none can be created
 * today — see the PR description's Discord section), so this 400s for
 * any non-YOUTUBE collection rather than silently no-op'ing.
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

    let discovery;
    try {
      discovery = await discoverYoutubeChannelVideos(collection.externalId);
    } catch (err) {
      const message = err instanceof YouTubeChannelDiscoveryError ? err.message : "Could not refresh this channel.";
      await markCollectionSyncFailed(deps.pool, collection.id, message);
      res.status(502).json({ error: { message, type: "channel_discovery_failed" } });
      return;
    }

    await markCollectionSynced(deps.pool, collection.id, discovery.channelTitle);

    let importedCount = 0;
    let adoptedCount = 0;
    for (const video of discovery.videos) {
      const { created } = await createYouTubeSource(deps.pool, {
        projectId: project.id,
        externalId: video.videoId,
        sourceUrl: video.sourceUrl,
        collectionId: collection.id,
        title: video.title,
      });
      if (created) importedCount++;
      else adoptedCount++;
    }

    const refreshedCollection = await getSourceCollectionById(deps.pool, collection.id);
    res.status(200).json({
      collection: (await summarizeCollections(deps.pool, [refreshedCollection!]))[0],
      discoveredCount: discovery.videos.length,
      importedCount,
      adoptedCount,
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
