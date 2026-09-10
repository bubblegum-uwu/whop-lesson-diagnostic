import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getCoursesByProjectId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getCourseSpendSummary } from "../../db/lessonAnalysesRepo.js";
import {
  createYouTubeSource,
  listProjectSourcesByProjectId,
  type ProjectSourceRow,
} from "../../db/projectSourcesRepo.js";
import { parseYouTubeVideoUrl, YouTubeUrlParseError } from "../../lib/youtubeUrl.js";

export interface ProjectSourcesRouteDeps {
  pool: Pool;
}

export type SourceProvider = "WHOP" | "YOUTUBE";
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
}

export type ProjectSource = WhopProjectSource | YouTubeProjectSource;

function toYouTubeProjectSource(row: ProjectSourceRow): YouTubeProjectSource {
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

    const [courses, youtubeRows] = await Promise.all([
      getCoursesByProjectId(deps.pool, projectId),
      listProjectSourcesByProjectId(deps.pool, projectId),
    ]);

    const whopSources: ProjectSource[] = await Promise.all(
      courses.map(async (course): Promise<WhopProjectSource> => {
        const lessons = await listLessons(deps.pool, course.id);
        const lessonIds = lessons.map((l) => l.id);
        const [counts, spend] = await Promise.all([
          getSummaryCounts(deps.pool, lessonIds),
          getCourseSpendSummary(deps.pool, lessonIds),
        ]);
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
      }),
    );

    const sources: ProjectSource[] = [...whopSources, ...youtubeRows.map(toYouTubeProjectSource)];

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

    res.status(created ? 201 : 200).json({ source: toYouTubeProjectSource(source), duplicate: !created });
  };
}
