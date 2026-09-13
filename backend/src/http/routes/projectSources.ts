import type { Request, Response } from "express";
import type { Pool } from "pg";
import type { KnoveraAuthedRequest } from "../middleware/knoveraAuth.js";
import { getProjectById } from "../../db/projectsRepo.js";
import { getCoursesByProjectId, type CourseRow } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getCourseSpendSummary } from "../../db/lessonAnalysesRepo.js";
import {
  createYouTubeSource,
  createDiscordSource,
  deleteProjectSource,
  listProjectSourcesByProjectId,
  getProjectSourceById,
  type ProjectSourceRow,
} from "../../db/projectSourcesRepo.js";
import { saveContentAssetMedia, deleteContentAsset, getContentAssetById } from "../../db/contentAssetsRepo.js";
import { createSourceCollection, getSourceCollectionById } from "../../db/sourceCollectionsRepo.js";
import {
  insertManualOrigin,
  insertDiscordChannelOrigin,
  listOriginsBySourceIds,
  type ProjectSourceOriginRow,
} from "../../db/projectSourceOriginsRepo.js";
import { parseYouTubeVideoUrl, YouTubeUrlParseError } from "../../lib/youtubeUrl.js";
import { parseDiscordVideoUrl, DiscordUrlParseError } from "../../lib/discordUrl.js";
import {
  downloadDiscordAttachment as defaultDownloadDiscordAttachment,
  DiscordAttachmentDownloadError,
  type DownloadedDiscordAttachment,
} from "../../discord/downloadDiscordAttachment.js";

export interface ProjectSourcesRouteDeps {
  pool: Pool;
  /** Overridable only for tests — production always uses the real HTTP downloader. */
  downloadDiscordAttachment?: (sourceUrl: string) => Promise<DownloadedDiscordAttachment>;
}

export type SourceProvider = "WHOP" | "YOUTUBE" | "DISCORD";
export type SourceType = "COURSE" | "VIDEO";

export interface WhopProjectSource {
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
  lastSyncedAt: Date | null;
  totalCost: number | null;
}

/**
 * Phase 4K-C — one provenance record on a YouTube project source's API
 * response. `discordPostedAt` is always the DISCORD MESSAGE's timestamp
 * (see the migration's doc comment) — never a YouTube publish date or an
 * import/scan timestamp. `discordChannelName` is null when the browser
 * companion couldn't safely derive one; the frontend falls back to
 * displaying `discordChannelId` rather than fabricating a name.
 */
export interface ProjectSourceOriginSummary {
  originType: "MANUAL" | "DISCORD_CHANNEL";
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordChannelName: string | null;
  discordMessageId: string | null;
  discordMessageUrl: string | null;
  discordPostedAt: Date | null;
}

function toOriginSummary(row: ProjectSourceOriginRow): ProjectSourceOriginSummary {
  return {
    originType: row.originType,
    discordGuildId: row.discordGuildId,
    discordChannelId: row.discordChannelId,
    discordChannelName: row.discordChannelName,
    discordMessageId: row.discordMessageId,
    discordMessageUrl: row.discordMessageUrl,
    discordPostedAt: row.discordPostedAt,
  };
}

/**
 * Phase 4H-A — the first non-Whop project source. Deliberately NOT forced
 * into WhopProjectSource's shape (no fake courseId/lessonCount/etc.) — see
 * the Phase 4H-A PR description's "one coherent source representation,
 * provider-specific optional metadata" rule. `status` here is
 * source-record readiness (see projectSourcesRepo.ts) — Phase 4H-A never
 * analyzes anything, so this is never an analysis-progress indicator.
 */
export interface YouTubeProjectSource {
  provider: "YOUTUBE";
  sourceType: "VIDEO";
  id: number;
  externalId: string;
  sourceUrl: string;
  title: string | null;
  durationSeconds: number | null;
  status: string;
  createdAt: Date;
  /** Phase 4K — the source_collections row (a YouTube channel) this video was discovered through, or null for an à-la-carte add. */
  collectionId: number | null;
  /**
   * Phase 4K-C — every known provenance record for this source, oldest
   * first. Empty for a source that predates this phase (never backfilled —
   * see the migration/repo doc comments: an unknown origin stays unknown,
   * it is never inferred as "Manual").
   */
  origins: ProjectSourceOriginSummary[];
}

/**
 * Phase 4I — the second non-Whop project source, same shape/reasoning as
 * YouTubeProjectSource (a coherent VIDEO source, not forced into either
 * WhopProjectSource or a Discord-specific shape). `sourceUrl` here is the
 * exact Discord CDN attachment link, not a normalized/reconstructed form —
 * see lib/discordUrl.ts's doc comment on why it can't be.
 */
export interface DiscordProjectSource {
  provider: "DISCORD";
  sourceType: "VIDEO";
  id: number;
  externalId: string;
  sourceUrl: string;
  title: string | null;
  durationSeconds: number | null;
  status: string;
  createdAt: Date;
  /** Phase 4K — always null today (Discord collection discovery is not implemented — see the PR description); kept for API shape symmetry with YouTubeProjectSource. */
  collectionId: number | null;
}

export type ProjectSource = WhopProjectSource | YouTubeProjectSource | DiscordProjectSource;

function toYouTubeProjectSource(row: ProjectSourceRow, origins: ProjectSourceOriginRow[] = []): YouTubeProjectSource {
  return {
    provider: "YOUTUBE",
    sourceType: "VIDEO",
    id: row.id,
    externalId: row.externalId,
    sourceUrl: row.sourceUrl,
    title: row.title,
    durationSeconds: row.durationSeconds,
    status: row.status,
    createdAt: row.createdAt,
    collectionId: row.collectionId,
    origins: origins.map(toOriginSummary),
  };
}

function toDiscordProjectSource(row: ProjectSourceRow): DiscordProjectSource {
  return {
    provider: "DISCORD",
    sourceType: "VIDEO",
    id: row.id,
    externalId: row.externalId,
    sourceUrl: row.sourceUrl,
    title: row.title,
    durationSeconds: row.durationSeconds,
    status: row.status,
    createdAt: row.createdAt,
    collectionId: row.collectionId,
  };
}

/**
 * Dispatches a raw project_sources row to its provider-specific response
 * shape — the one place that mapping happens, so a new provider means one
 * new branch here, never a change to the GET handler's own logic. Exported
 * for reuse by http/routes/synthesisSets.ts, which needs the same
 * provider-specific source shape for its detail view's member list — the
 * one place this mapping happens, never duplicated. `origins` is optional
 * (defaults to none): synthesisSets.ts's member-list view doesn't batch-
 * fetch provenance, so it always renders an empty `origins` array there —
 * honest (no provenance was looked up), never fabricated.
 */
export function toProjectSource(row: ProjectSourceRow, origins: ProjectSourceOriginRow[] = []): YouTubeProjectSource | DiscordProjectSource {
  return row.provider === "YOUTUBE" ? toYouTubeProjectSource(row, origins) : toDiscordProjectSource(row);
}

/**
 * Builds one course's WhopProjectSource summary (lesson/analysis counts +
 * spend). Extracted from the original inline GET-handler mapping (Phase
 * 4C) so Phase 4K's whopCourses.ts route can return the exact same shape
 * right after connecting/refreshing a course, without duplicating this
 * logic or changing what it computes.
 */
export async function buildWhopProjectSource(pool: Pool, course: CourseRow): Promise<WhopProjectSource> {
  const lessons = await listLessons(pool, course.id);
  const lessonIds = lessons.map((l) => l.id);
  const [counts, spend] = await Promise.all([getSummaryCounts(pool, lessonIds), getCourseSpendSummary(pool, lessonIds)]);
  const analyzedLessonCount = counts.completed + counts.noStrategy;
  const accountedFor = analyzedLessonCount + counts.processing + counts.queued + counts.failed + counts.authRequired + counts.cancelled;

  return {
    provider: "WHOP",
    sourceType: "COURSE",
    courseId: course.id,
    externalId: course.whopCourseId,
    name: course.title,
    lessonCount: lessons.length,
    analyzedLessonCount,
    queuedCount: counts.queued,
    processingCount: counts.processing,
    failedCount: counts.failed,
    remainingCount: Math.max(0, lessons.length - accountedFor),
    lastSyncedAt: course.lastSyncedAt,
    totalCost: spend.totalCost,
  };
}

/**
 * GET /api/projects/:projectId/sources — every real, connected source this
 * project owns, combined from two independent ownership paths: Whop
 * courses (via `courses.project_id`, unchanged since Phase 4C — see the
 * loop below) and, as of Phase 4H-A, persisted `project_sources` rows
 * (`project_sources.project_id` directly, see projectSourcesRepo.ts).
 * Neither path falls back to a globally configured identifier — a project
 * with neither legitimately returns `sources: []`.
 */
export function createGetProjectSourcesHandler(deps: ProjectSourcesRouteDeps) {
  return async function getProjectSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const [courses, nonWhopRows] = await Promise.all([
      getCoursesByProjectId(deps.pool, projectId),
      listProjectSourcesByProjectId(deps.pool, projectId),
    ]);

    // Phase 4K-C — provenance is only ever recorded for YOUTUBE sources
    // (see toOriginSummary/YouTubeProjectSource); batched in one query for
    // every YouTube row on this page, never per-row (no N+1).
    const youtubeSourceIds = nonWhopRows.filter((row) => row.provider === "YOUTUBE").map((row) => row.id);
    const [whopSources, originsBySourceId] = await Promise.all([
      Promise.all(courses.map((course) => buildWhopProjectSource(deps.pool, course))),
      listOriginsBySourceIds(deps.pool, youtubeSourceIds),
    ]);

    const sources: ProjectSource[] = [
      ...whopSources,
      ...nonWhopRows.map((row) => toProjectSource(row, originsBySourceId.get(row.id) ?? [])),
    ];

    res.status(200).json({ projectId, sources });
  };
}

interface AddYouTubeSourceBody {
  url?: unknown;
}

/**
 * POST /api/projects/:projectId/sources/youtube — Phase 4H-A. Stores the
 * canonical identity of a public YouTube video as a project source; never
 * fetches the video, its metadata, or its captions (that's Phase 4H-B).
 * `parseYouTubeVideoUrl` is a pure parser — no network call is made before
 * or during this handler, so the raw request URL never reaches any process
 * or outbound fetch (see lib/youtubeUrl.ts's SSRF-hardening comment).
 *
 * Requires Knovera auth only (wired in http/app.ts) — never
 * requireWhopConnected. Whop's connection state is irrelevant here: a
 * project with Whop fully disconnected (or never connected at all) can
 * still add a YouTube source.
 *
 * Duplicate handling is deterministic and race-safe (see
 * projectSourcesRepo.createYouTubeSource's ON CONFLICT): a video already
 * present in this project returns 200 with the existing row and
 * `duplicate: true`, never a raw unique-violation 500. A brand-new video
 * returns 201 with `duplicate: false`.
 */
export function createAddYouTubeSourceHandler(deps: ProjectSourcesRouteDeps) {
  return async function addYouTubeSourceHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const body = req.body as AddYouTubeSourceBody;
    if (typeof body?.url !== "string" || body.url.trim().length === 0) {
      res.status(400).json({ error: { message: "Missing url.", type: "invalid_request" } });
      return;
    }

    let parsed;
    try {
      parsed = parseYouTubeVideoUrl(body.url);
    } catch (err) {
      res.status(400).json({
        error: {
          message: err instanceof YouTubeUrlParseError ? err.message : "Could not parse YouTube URL.",
          type: "invalid_youtube_url",
        },
      });
      return;
    }

    const { source, created } = await createYouTubeSource(deps.pool, {
      projectId,
      externalId: parsed.externalId,
      sourceUrl: parsed.sourceUrl,
    });

    // Phase 4K-C — every manually-pasted URL (new source or an existing
    // one, e.g. previously discovered via Discord) gets a MANUAL
    // provenance record; insertManualOrigin is idempotent, so re-adding the
    // same video through this flow twice never creates a second row.
    await insertManualOrigin(deps.pool, source.id);
    const origins = await listOriginsBySourceIds(deps.pool, [source.id]);

    res.status(created ? 201 : 200).json({ source: toYouTubeProjectSource(source, origins.get(source.id) ?? []), duplicate: !created });
  };
}

interface AddDiscordSourceBody {
  url?: unknown;
}

/**
 * POST /api/projects/:projectId/sources/discord — Phase 4I. Stores the
 * identity of a Discord video attachment as a project source AND, for a
 * brand-new (non-duplicate) source, durably captures its video bytes
 * immediately — while the just-pasted signed URL is still guaranteed
 * valid. `parseDiscordVideoUrl` is a pure parser, so URL validation itself
 * makes no network call; the actual download happens only after that
 * validation and only for a genuinely new source.
 *
 * WHY: a Discord CDN URL's signature expires and cannot be reconstructed
 * later (no bot/API access to re-request one) — see the
 * 1789600000000_project-source-media.sql migration's comment. Capturing
 * the durable copy at ANY later point (e.g. lazily on first Analyze) would
 * not fix this: the user could wait hours or days before ever clicking
 * Analyze, by which time the pasted URL may already be dead. This is the
 * only moment durability can be guaranteed, so it happens here,
 * synchronously, before responding.
 *
 * On a download failure, the just-created project_sources row is deleted
 * (compensating cleanup — see projectSourcesRepo.deleteProjectSource's doc
 * comment) and a clear, retryable error is returned; no broken,
 * un-analyzable source is ever left behind. A duplicate add (the video was
 * already a source of this project) skips the download entirely — by
 * invariant, any existing DISCORD project_source already has its media
 * captured, since a row only survives creation when that capture
 * succeeded.
 *
 * Same auth/isolation conventions as createAddYouTubeSourceHandler above:
 * Knovera auth only (never requireWhopConnected), race-safe duplicate
 * handling via projectSourcesRepo.createDiscordSource's ON CONFLICT.
 */
export function createAddDiscordSourceHandler(deps: ProjectSourcesRouteDeps) {
  return async function addDiscordSourceHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const body = req.body as AddDiscordSourceBody;
    if (typeof body?.url !== "string" || body.url.trim().length === 0) {
      res.status(400).json({ error: { message: "Missing url.", type: "invalid_request" } });
      return;
    }

    let parsed;
    try {
      parsed = parseDiscordVideoUrl(body.url);
    } catch (err) {
      res.status(400).json({
        error: {
          message: err instanceof DiscordUrlParseError ? err.message : "Could not parse Discord attachment URL.",
          type: "invalid_discord_url",
        },
      });
      return;
    }

    const { source, created, assetCreated, contentAssetId } = await createDiscordSource(deps.pool, {
      projectId,
      ownerIdentity: (req as KnoveraAuthedRequest).knoveraOperator!,
      externalId: parsed.externalId,
      sourceUrl: parsed.sourceUrl,
    });

    // Phase 4K-B (revised) — durable capture is keyed off `assetCreated`,
    // not `created`: an attachment already captured (à la carte, via Save
    // to Knovera, or in a different project this identity owns) is NEVER
    // re-downloaded, even when this is the first time IT lands in THIS
    // project (created:true, assetCreated:false).
    if (assetCreated) {
      try {
        const downloadDiscordAttachment = deps.downloadDiscordAttachment ?? defaultDownloadDiscordAttachment;
        const media = await downloadDiscordAttachment(parsed.sourceUrl);
        await saveContentAssetMedia(deps.pool, { contentAssetId, content: media.content, contentType: media.contentType, byteSize: media.byteSize });
      } catch (err) {
        // Order matters: project_sources.content_asset_id references
        // content_assets ON DELETE RESTRICT, so the referencing row must
        // go first.
        if (created) await deleteProjectSource(deps.pool, source.id);
        await deleteContentAsset(deps.pool, contentAssetId);
        res.status(502).json({
          error: {
            message: err instanceof DiscordAttachmentDownloadError ? err.message : "Could not download this Discord attachment. Please try again.",
            type: "discord_media_unavailable",
          },
        });
        return;
      }
    }

    res.status(created ? 201 : 200).json({ source: toDiscordProjectSource(source), duplicate: !created });
  };
}

interface BatchAddSourcesBody {
  urls?: unknown;
}

export type BatchAddResultKind = "added" | "duplicate" | "invalid";
export interface BatchAddResultEntry {
  url: string;
  kind: BatchAddResultKind;
  source?: YouTubeProjectSource | DiscordProjectSource;
  message?: string;
}
export interface BatchAddSourcesResponse {
  results: BatchAddResultEntry[];
  addedCount: number;
  duplicateCount: number;
  invalidCount: number;
}

const MAX_BATCH_URLS = 50;

function summarizeBatch(results: BatchAddResultEntry[]): BatchAddSourcesResponse {
  return {
    results,
    addedCount: results.filter((r) => r.kind === "added").length,
    duplicateCount: results.filter((r) => r.kind === "duplicate").length,
    invalidCount: results.filter((r) => r.kind === "invalid").length,
  };
}

function parseBatchUrls(body: BatchAddSourcesBody, res: Response): string[] | null {
  if (!Array.isArray(body?.urls) || body.urls.length === 0) {
    res.status(400).json({ error: { message: "urls must be a non-empty array.", type: "invalid_request" } });
    return null;
  }
  if (body.urls.length > MAX_BATCH_URLS) {
    res.status(400).json({ error: { message: `At most ${MAX_BATCH_URLS} URLs per batch.`, type: "invalid_request" } });
    return null;
  }
  if (!body.urls.every((u): u is string => typeof u === "string")) {
    res.status(400).json({ error: { message: "Every entry in urls must be a string.", type: "invalid_request" } });
    return null;
  }
  return body.urls;
}

/**
 * POST /api/projects/:projectId/sources/youtube/batch — Phase 4K. Multiple
 * URLs, one per line/array entry, each independently validated/deduped/
 * imported — never fails the whole batch because one entry is malformed
 * (spec section 19/52). Reuses createYouTubeSource unchanged (no network
 * acquisition for YouTube, same as the single-URL handler above) — never
 * analyzes anything. Phase 4K-C: this is still a manually-pasted flow (a
 * batch of individual pastes, not a Discord discovery), so every entry
 * also gets an idempotent MANUAL provenance record, same as the single-URL
 * handler.
 */
export function createBatchAddYouTubeSourcesHandler(deps: ProjectSourcesRouteDeps) {
  return async function batchAddYouTubeSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const urls = parseBatchUrls(req.body as BatchAddSourcesBody, res);
    if (!urls) return;

    const results: BatchAddResultEntry[] = [];
    for (const url of urls) {
      let parsed;
      try {
        parsed = parseYouTubeVideoUrl(url);
      } catch (err) {
        results.push({ url, kind: "invalid", message: err instanceof YouTubeUrlParseError ? err.message : "Could not parse YouTube URL." });
        continue;
      }
      const { source, created } = await createYouTubeSource(deps.pool, { projectId, externalId: parsed.externalId, sourceUrl: parsed.sourceUrl });
      await insertManualOrigin(deps.pool, source.id);
      const origins = await listOriginsBySourceIds(deps.pool, [source.id]);
      results.push({ url, kind: created ? "added" : "duplicate", source: toYouTubeProjectSource(source, origins.get(source.id) ?? []) });
    }

    res.status(200).json(summarizeBatch(results));
  };
}

/**
 * POST /api/projects/:projectId/sources/discord/batch — Phase 4K. Same
 * partial-success batch shape as the YouTube batch handler above, but
 * each newly-created entry still goes through the EXACT same durable-
 * capture-or-compensating-delete path as the single-URL Discord handler
 * (never weakened — spec section 24): host validation via
 * parseDiscordVideoUrl, then an immediate download attempt, with the
 * created row deleted and reported as "invalid" (not silently dropped) if
 * that capture fails.
 */
export function createBatchAddDiscordSourcesHandler(deps: ProjectSourcesRouteDeps) {
  return async function batchAddDiscordSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const urls = parseBatchUrls(req.body as BatchAddSourcesBody, res);
    if (!urls) return;

    const results: BatchAddResultEntry[] = [];
    for (const url of urls) {
      let parsed;
      try {
        parsed = parseDiscordVideoUrl(url);
      } catch (err) {
        results.push({ url, kind: "invalid", message: err instanceof DiscordUrlParseError ? err.message : "Could not parse Discord attachment URL." });
        continue;
      }

      const { source, created, assetCreated, contentAssetId } = await createDiscordSource(deps.pool, {
        projectId,
        ownerIdentity: (req as KnoveraAuthedRequest).knoveraOperator!,
        externalId: parsed.externalId,
        sourceUrl: parsed.sourceUrl,
      });
      if (!created) {
        results.push({ url, kind: "duplicate", source: toDiscordProjectSource(source) });
        continue;
      }

      if (!assetCreated) {
        // Already-captured media (à la carte elsewhere, Save to Knovera, or
        // another project this identity owns) — never re-downloaded.
        results.push({ url, kind: "added", source: toDiscordProjectSource(source) });
        continue;
      }

      try {
        const downloadDiscordAttachment = deps.downloadDiscordAttachment ?? defaultDownloadDiscordAttachment;
        const media = await downloadDiscordAttachment(parsed.sourceUrl);
        await saveContentAssetMedia(deps.pool, { contentAssetId, content: media.content, contentType: media.contentType, byteSize: media.byteSize });
        results.push({ url, kind: "added", source: toDiscordProjectSource(source) });
      } catch (err) {
        // Order matters — see createAddDiscordSourceHandler's identical comment.
        await deleteProjectSource(deps.pool, source.id);
        await deleteContentAsset(deps.pool, contentAssetId);
        results.push({
          url,
          kind: "invalid",
          message: err instanceof DiscordAttachmentDownloadError ? err.message : "Could not download this Discord attachment.",
        });
      }
    }

    res.status(200).json(summarizeBatch(results));
  };
}

interface DiscordImportChannelBody {
  guildId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
}

interface ParsedDiscordImportChannel {
  guildId: string;
  channelId: string;
  channelName: string | null;
}

function parseDiscordImportChannel(channel: unknown, res: Response): ParsedDiscordImportChannel | null {
  if (typeof channel !== "object" || channel === null) {
    res.status(400).json({ error: { message: "channel is required.", type: "invalid_request" } });
    return null;
  }
  const c = channel as DiscordImportChannelBody;
  if (typeof c.guildId !== "string" || c.guildId.trim().length === 0) {
    res.status(400).json({ error: { message: "channel.guildId is required.", type: "invalid_request" } });
    return null;
  }
  if (typeof c.channelId !== "string" || c.channelId.trim().length === 0) {
    res.status(400).json({ error: { message: "channel.channelId is required.", type: "invalid_request" } });
    return null;
  }
  const channelName = typeof c.channelName === "string" && c.channelName.trim().length > 0 ? c.channelName : null;
  return { guildId: c.guildId, channelId: c.channelId, channelName };
}

const MAX_DISCORD_IMPORT_OCCURRENCES = 500;

function parseDiscordImportOccurrences(occurrences: unknown, res: Response): unknown[] | null {
  if (!Array.isArray(occurrences) || occurrences.length === 0) {
    res.status(400).json({ error: { message: "occurrences must be a non-empty array.", type: "invalid_request" } });
    return null;
  }
  if (occurrences.length > MAX_DISCORD_IMPORT_OCCURRENCES) {
    res.status(400).json({ error: { message: `At most ${MAX_DISCORD_IMPORT_OCCURRENCES} occurrences per request.`, type: "invalid_request" } });
    return null;
  }
  return occurrences;
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
  enrichedOriginCount: number;
  duplicateOriginCount: number;
  invalidCount: number;
}

/**
 * POST /api/projects/:projectId/sources/youtube/discord-import — Phase
 * 4K-C. Commits the browser companion's scan results: one Discord channel
 * (validated once, shared across every occurrence in the request) plus a
 * list of `{youtubeUrl, messageId, messageUrl, postedAt}` occurrences, each
 * independently validated/canonicalized/imported — never fails the whole
 * request because one occurrence is malformed, same partial-success
 * convention as the batch-add handlers above.
 *
 * The browser companion's extracted URLs/ids/timestamps are treated as
 * UNTRUSTED input end to end: `parseYouTubeVideoUrl` re-validates and
 * re-canonicalizes every URL server-side (never trusts a companion-supplied
 * externalId), and messageId/postedAt are independently validated here too.
 *
 * Source identity/dedup is unchanged from every other YouTube-add path —
 * `createYouTubeSource`'s own `ON CONFLICT (project_id, provider,
 * external_id)`. What's new is the provenance layer on top
 * (insertDiscordChannelOrigin, idempotent per (source, channel, message) —
 * see the migration/repo doc comments), which is what turns "found this
 * video 3 times across 2 channels while re-scanning" into "1 source, up to
 * 3 provenance rows," never duplicate sources and never lost occurrences.
 *
 * Per-occurrence result kinds distinguish exactly what happened: `added` (a
 * brand-new project_source), `existing_source_new_origin` (the video was
 * already a source of this project — from a manual add, another channel,
 * or an earlier scan — and this occurrence added a new provenance row to
 * it), `existing_origin_enriched` (this exact Discord message was already
 * recorded as an origin, but was missing its channel name and/or message
 * URL — now filled in from this scan, never overwriting a value it already
 * had — see insertDiscordChannelOrigin's doc comment), `duplicate_origin`
 * (this exact Discord message was already recorded with nothing left to
 * enrich — re-scanning the same channel is safe to repeat), and `invalid`
 * (malformed occurrence — never partially applied).
 *
 * Never calls the analysis endpoint, jobTrigger, or any synthesis
 * function — imported sources begin in the same NOT-analyzed state as
 * every other newly-created project_sources row (see createYouTubeSource,
 * unchanged). This handler's deps intentionally carry no jobTrigger.
 */
export function createDiscordImportYouTubeSourcesHandler(deps: ProjectSourcesRouteDeps) {
  return async function discordImportYouTubeSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json({ error: { message: "Unknown project.", type: "project_not_found" } });
      return;
    }

    const body = req.body as { channel?: unknown; occurrences?: unknown };
    const channel = parseDiscordImportChannel(body?.channel, res);
    if (!channel) return;
    const occurrences = parseDiscordImportOccurrences(body?.occurrences, res);
    if (!occurrences) return;

    const results: DiscordImportResultEntry[] = [];
    for (const rawOccurrence of occurrences) {
      if (typeof rawOccurrence !== "object" || rawOccurrence === null) {
        results.push({ youtubeUrl: "", messageId: "", kind: "invalid", message: "Malformed occurrence." });
        continue;
      }
      const occ = rawOccurrence as { youtubeUrl?: unknown; messageId?: unknown; messageUrl?: unknown; postedAt?: unknown };
      const youtubeUrl = typeof occ.youtubeUrl === "string" ? occ.youtubeUrl : "";
      const messageId = typeof occ.messageId === "string" ? occ.messageId.trim() : "";

      if (messageId.length === 0) {
        results.push({ youtubeUrl, messageId, kind: "invalid", message: "Missing Discord message id." });
        continue;
      }

      const postedAt = typeof occ.postedAt === "string" ? new Date(occ.postedAt) : null;
      if (!postedAt || Number.isNaN(postedAt.getTime())) {
        results.push({ youtubeUrl, messageId, kind: "invalid", message: "Missing or invalid Discord message timestamp." });
        continue;
      }

      const messageUrl = typeof occ.messageUrl === "string" && occ.messageUrl.trim().length > 0 ? occ.messageUrl : null;

      let parsed;
      try {
        parsed = parseYouTubeVideoUrl(youtubeUrl);
      } catch (err) {
        results.push({
          youtubeUrl,
          messageId,
          kind: "invalid",
          message: err instanceof YouTubeUrlParseError ? err.message : "Could not parse YouTube URL.",
        });
        continue;
      }

      const { source, created: sourceCreated } = await createYouTubeSource(deps.pool, {
        projectId,
        externalId: parsed.externalId,
        sourceUrl: parsed.sourceUrl,
      });

      const { outcome: originOutcome } = await insertDiscordChannelOrigin(deps.pool, {
        projectSourceId: source.id,
        guildId: channel.guildId,
        channelId: channel.channelId,
        channelName: channel.channelName,
        messageId,
        messageUrl,
        postedAt,
      });

      const origins = await listOriginsBySourceIds(deps.pool, [source.id]);
      const kind: DiscordImportResultKind = sourceCreated
        ? "added"
        : originOutcome === "created"
          ? "existing_source_new_origin"
          : originOutcome === "enriched"
            ? "existing_origin_enriched"
            : "duplicate_origin";
      results.push({ youtubeUrl, messageId, kind, source: toYouTubeProjectSource(source, origins.get(source.id) ?? []) });
    }

    const response: DiscordImportResponse = {
      results,
      occurrencesProcessed: occurrences.length,
      newSourceCount: results.filter((r) => r.kind === "added").length,
      newOriginCount: results.filter((r) => r.kind === "existing_source_new_origin").length,
      enrichedOriginCount: results.filter((r) => r.kind === "existing_origin_enriched").length,
      duplicateOriginCount: results.filter((r) => r.kind === "duplicate_origin").length,
      invalidCount: results.filter((r) => r.kind === "invalid").length,
    };

    res.status(200).json(response);
  };
}

export type AddToProjectResultKind = "added" | "already_present" | "unauthorized" | "invalid";
export interface AddToProjectResultEntry {
  projectId: number;
  kind: AddToProjectResultKind;
  source?: DiscordProjectSource;
}
export interface AddToProjectResponse {
  results: AddToProjectResultEntry[];
}

interface AddToProjectBody {
  targetProjectIds?: unknown;
}

const MAX_ADD_TO_PROJECT_TARGETS = 20;

const SOURCE_NOT_SHAREABLE_RESPONSE = {
  error: { message: "Only captured Discord sources can be added to other projects right now.", type: "source_not_shareable" },
} as const;

/**
 * POST /api/projects/:projectId/sources/:sourceId/add-to-projects — Phase
 * 4K-B (revised). Makes an already-captured Discord source's durable
 * content available in one or more OTHER projects, of ANY project type,
 * without copying media, calling Gemini, or removing it from its current
 * project (spec sections 40-48). The shared content_assets/
 * content_asset_media layer (see contentAssetsRepo.ts) is what makes this
 * possible — every target simply gets its own project_sources row
 * pointing at the SAME content_asset_id; deleting one never touches the
 * others (content_assets is only ever deleted once nothing references it —
 * see deleteContentAsset's doc comment).
 *
 * Authorization here is asset-level, not project-level — this app has no
 * concept of project ownership at all (see projectsRepo.ts /
 * 1789300000000_project-model.sql: `projects` carries no owner/identity
 * column, and today's single-Knovera-operator deployment never needs one).
 * The one authorization dimension that DOES exist is content_assets'
 * owner_identity (see contentAssetsRepo.ts) — the caller must be the exact
 * identity that owns the source's underlying asset (ordinarily the
 * identity that originally captured it). If not, EVERY requested target
 * comes back "unauthorized" rather than a top-level 403 — this keeps the
 * response shape uniform regardless of why a given target didn't succeed,
 * and mirrors the existing batch-add routes' one-result-per-item shape.
 * Never actually reachable in today's single-operator deployment (there is
 * only one identity), but fails closed rather than silently ignoring
 * ownership, for whenever that changes.
 */
export function createAddProjectSourceToProjectsHandler(deps: ProjectSourcesRouteDeps) {
  return async function addProjectSourceToProjectsHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    const sourceId = Number(req.params.sourceId);
    if (!Number.isInteger(projectId) || !Number.isInteger(sourceId)) {
      res.status(404).json({ error: { message: "Unknown project source.", type: "project_source_not_found" } });
      return;
    }

    const source = await getProjectSourceById(deps.pool, sourceId);
    if (!source || source.projectId !== projectId) {
      res.status(404).json({ error: { message: "Unknown project source.", type: "project_source_not_found" } });
      return;
    }

    // Phase 4K-B (revised) scope note (spec section 38): the shared
    // content_asset layer exists for Discord only — YouTube/Whop sources
    // never carry a content_asset_id and are never shareable this way.
    if (source.provider !== "DISCORD" || source.contentAssetId == null) {
      res.status(400).json(SOURCE_NOT_SHAREABLE_RESPONSE);
      return;
    }

    const asset = await getContentAssetById(deps.pool, source.contentAssetId);
    if (!asset) {
      // Unreachable — project_sources.content_asset_id references
      // content_assets ON DELETE RESTRICT, so the asset can never be gone
      // while this source still exists. Defensive only.
      res.status(400).json(SOURCE_NOT_SHAREABLE_RESPONSE);
      return;
    }

    const requesterIdentity = (req as KnoveraAuthedRequest).knoveraOperator!;
    const authorized = asset.ownerIdentity === requesterIdentity;

    const body = req.body as AddToProjectBody;
    if (!Array.isArray(body?.targetProjectIds) || body.targetProjectIds.length === 0) {
      res.status(400).json({ error: { message: "targetProjectIds is required.", type: "invalid_request" } });
      return;
    }
    if (body.targetProjectIds.length > MAX_ADD_TO_PROJECT_TARGETS) {
      res.status(400).json({
        error: { message: `At most ${MAX_ADD_TO_PROJECT_TARGETS} target projects per request.`, type: "invalid_request" },
      });
      return;
    }

    // The original channel collection (if this source has one) is
    // resolved ONCE up front, never per target — spec section 51: "prefer
    // creating/reusing the corresponding Discord channel collection in the
    // target project." Each target gets its own collection row via the
    // SAME stable (provider, external_id) identity, created or reused —
    // never enabling refresh there, exactly like the source's own
    // collection (organizational only; nothing to crawl).
    const originalCollection = source.collectionId != null ? await getSourceCollectionById(deps.pool, source.collectionId) : null;

    const results: AddToProjectResultEntry[] = [];
    for (const rawTargetProjectId of body.targetProjectIds) {
      const targetProjectId = Number(rawTargetProjectId);
      if (!Number.isInteger(targetProjectId)) {
        results.push({ projectId: Number.isFinite(targetProjectId) ? targetProjectId : -1, kind: "invalid" });
        continue;
      }

      if (!authorized) {
        results.push({ projectId: targetProjectId, kind: "unauthorized" });
        continue;
      }

      const targetProject = await getProjectById(deps.pool, targetProjectId);
      if (!targetProject) {
        results.push({ projectId: targetProjectId, kind: "invalid" });
        continue;
      }

      let targetCollectionId: number | null = null;
      if (originalCollection) {
        const { collection } = await createSourceCollection(deps.pool, {
          projectId: targetProjectId,
          provider: originalCollection.provider,
          externalId: originalCollection.externalId,
          title: originalCollection.title,
          sourceUrl: originalCollection.sourceUrl,
        });
        targetCollectionId = collection.id;
      }

      // Never downloads, never touches content_asset_media, never calls
      // Gemini or creates an analysis job — membership/reference only
      // (spec section 46/47). createDiscordSource's own upsert is what
      // makes this idempotent: a target that already has this exact
      // (project, external_id) source comes back `created:false` —
      // reported as already_present, never a duplicate row (this is also
      // exactly what makes re-adding to the SAME project the source is
      // already in a no-op "already_present", with no special-casing
      // needed here).
      const { source: targetSource, created } = await createDiscordSource(deps.pool, {
        projectId: targetProjectId,
        ownerIdentity: asset.ownerIdentity,
        externalId: source.externalId,
        sourceUrl: source.sourceUrl,
        collectionId: targetCollectionId,
        title: source.title,
      });

      results.push({ projectId: targetProjectId, kind: created ? "added" : "already_present", source: toDiscordProjectSource(targetSource) });
    }

    const response: AddToProjectResponse = { results };
    res.status(200).json(response);
  };
}
