import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getCourseByWhopId, getCoursesByProjectId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { syncCourse, type CourseSyncConfig } from "../../pipeline/courseSync.js";
import { buildWhopProjectSource } from "./projectSources.js";
import type { WhopCourseClient } from "../../whop/courseClient.js";
import type { WhopOAuthClient } from "../../whop/oauthClient.js";
import { getValidAccessToken, AuthRequiredError } from "../../whop/sessionService.js";
import { parseWhopCourseUrl, WhopCourseUrlParseError } from "../../lib/whopCourseUrl.js";
import { globalRedactor } from "../../lib/redact.js";
import { logger } from "../../lib/logger.js";

export interface WhopCoursesRouteDeps {
  pool: Pool;
  courseClient: WhopCourseClient;
  oauthClient: WhopOAuthClient;
  refreshTokenEncryptionKey: string;
}

const NOT_FOUND_PROJECT = { error: { message: "Unknown project.", type: "project_not_found" } } as const;

/**
 * Phase 4K — this app's FIRST multi-course-per-project capability.
 * Existing single-course assumptions (http/routes/projectSynthesis.ts's
 * resolveProjectSynthesisSource, the legacy Synthesis page) are entirely
 * unaffected: they already handle >1 course per project with an explicit
 * "multiple_sources" state (never an arbitrary "first course wins" — see
 * that file's own doc comment) — this route just makes reaching that
 * state possible for the first time, it does not change how it's handled.
 *
 * Uses the deployment's own single stored Whop OAuth session
 * (getValidAccessToken) — connecting an ADDITIONAL course never requires
 * a new OAuth flow, it just calls the same authenticated Course API with
 * a different courseId. The operator's Whop account must actually have
 * access to that course (Whop's own API enforces this — a course the
 * operator can't see 404s/403s here exactly like any other Whop API
 * call), so this can never be used to pull in a course belonging to
 * someone else's Whop account.
 */
async function resolveAccessToken(deps: WhopCoursesRouteDeps, res: Response): Promise<string | null> {
  try {
    const accessToken = await getValidAccessToken(deps.pool, deps.oauthClient, deps.refreshTokenEncryptionKey);
    globalRedactor.register(accessToken);
    return accessToken;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      res.status(401).json({ error: { message: err.message, type: "auth_required" } });
      return null;
    }
    throw err;
  }
}

interface ConnectCourseBody {
  courseUrl?: unknown;
}

/**
 * POST /api/projects/:projectId/whop-courses — connects an ADDITIONAL Whop
 * course to this project (a project may now own any number of courses;
 * see the migration/PR description for why the previous one-course
 * assumption lived only in synthesis, never in the source-catalog model
 * itself). Parses the pasted course URL, syncs its lesson catalog (never
 * analyzing any lesson — spec section 4/12), then claims `courses.project_id`
 * for this project — rejecting with a clear conflict if that exact course
 * is already connected to a DIFFERENT project (never silently
 * reassigning/"stealing" it).
 */
export function createConnectWhopCourseHandler(deps: WhopCoursesRouteDeps) {
  return async function connectWhopCourseHandler(req: Request, res: Response): Promise<void> {
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

    const body = req.body as ConnectCourseBody;
    if (typeof body?.courseUrl !== "string" || body.courseUrl.trim().length === 0) {
      res.status(400).json({ error: { message: "courseUrl is required.", type: "invalid_request" } });
      return;
    }
    let parsed;
    try {
      parsed = parseWhopCourseUrl(body.courseUrl);
    } catch (err) {
      res.status(400).json({ error: { message: err instanceof WhopCourseUrlParseError ? err.message : "Could not parse this Whop course URL.", type: "invalid_course_url" } });
      return;
    }

    const existingCourse = await getCourseByWhopId(deps.pool, parsed.courseId);
    if (existingCourse && existingCourse.projectId != null && existingCourse.projectId !== projectId) {
      res.status(409).json({ error: { message: "This Whop course is already connected to a different project.", type: "course_already_connected" } });
      return;
    }

    const accessToken = await resolveAccessToken(deps, res);
    if (accessToken === null) return;

    const config: CourseSyncConfig = { courseId: parsed.courseId, experienceId: parsed.experienceId, slug: parsed.companySlug };
    let syncResult;
    try {
      syncResult = await syncCourse(deps.pool, deps.courseClient, accessToken, config);
    } catch (err) {
      const safeMessage = globalRedactor.redact(err instanceof Error ? err.message : "Course sync failed.");
      logger.error("Whop course connect failed", { message: safeMessage });
      res.status(502).json({ error: { message: safeMessage, type: "course_sync_failed" } });
      return;
    }

    const course = await getCourseByWhopId(deps.pool, parsed.courseId);
    await deps.pool.query(`UPDATE courses SET project_id = $1, updated_at = now() WHERE id = $2`, [projectId, course!.id]);

    res.status(201).json({ course: await buildWhopProjectSource(deps.pool, course!), sync: syncResult });
  };
}

/** GET /api/projects/:projectId/whop-courses — every Whop course this project owns (already multi-course-capable — see coursesRepo.getCoursesByProjectId). Same summary shape GET /sources returns for WHOP entries. */
export function createListWhopCoursesHandler(deps: { pool: Pool }) {
  return async function listWhopCoursesHandler(req: Request, res: Response): Promise<void> {
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
    const courses = await getCoursesByProjectId(deps.pool, projectId);
    const summaries = await Promise.all(courses.map((c) => buildWhopProjectSource(deps.pool, c)));
    res.status(200).json({ projectId, courses: summaries });
  };
}

async function resolveOwnedCourse(pool: Pool, projectIdParam: string | string[], courseIdParam: string | string[]) {
  const projectId = Number(projectIdParam);
  const courseId = Number(courseIdParam);
  if (!Number.isInteger(projectId) || !Number.isInteger(courseId)) return null;
  const project = await getProjectById(pool, projectId);
  if (!project) return null;
  const courses = await getCoursesByProjectId(pool, projectId);
  const course = courses.find((c) => c.id === courseId);
  if (!course) return null;
  return { project, course };
}

/**
 * POST /api/projects/:projectId/whop-courses/:courseId/refresh — re-syncs
 * an already-connected course's lesson catalog (spec section 25/12).
 * Reuses the exact same syncCourse pipeline as connect — new lessons are
 * upserted, previously-synced lessons no longer returned by Whop are
 * soft-archived (lessonsRepo.syncLessons' existing behavior, unchanged),
 * and no lesson's analysis history is ever touched by this call.
 */
export function createRefreshWhopCourseHandler(deps: WhopCoursesRouteDeps) {
  return async function refreshWhopCourseHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCourse(deps.pool, req.params.projectId, req.params.courseId);
    if (!resolved) {
      res.status(404).json({ error: { message: "Unknown Whop course.", type: "course_not_found" } });
      return;
    }
    const { course } = resolved;

    const accessToken = await resolveAccessToken(deps, res);
    if (accessToken === null) return;

    const config: CourseSyncConfig = { courseId: course.whopCourseId, experienceId: course.whopExperienceId, slug: course.slug };
    try {
      const syncResult = await syncCourse(deps.pool, deps.courseClient, accessToken, config);
      res.status(200).json({ course: await buildWhopProjectSource(deps.pool, course), sync: syncResult });
    } catch (err) {
      const safeMessage = globalRedactor.redact(err instanceof Error ? err.message : "Course sync failed.");
      logger.error("Whop course refresh failed", { message: safeMessage, courseId: course.id });
      res.status(502).json({ error: { message: safeMessage, type: "course_sync_failed" } });
    }
  };
}

const LESSONS_PAGE_SIZE = 50;

/**
 * GET /api/projects/:projectId/whop-courses/:courseId/lessons — a single
 * course's lessons, paginated, with status only (never the lesson's own
 * full validated_json — spec section 47). Mirrors
 * sourceCollections.ts's createGetSourceCollectionHandler item-list shape,
 * applied to lessons instead of project_sources.
 */
export function createListWhopCourseLessonsHandler(deps: { pool: Pool }) {
  return async function listWhopCourseLessonsHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedCourse(deps.pool, req.params.projectId, req.params.courseId);
    if (!resolved) {
      res.status(404).json({ error: { message: "Unknown Whop course.", type: "course_not_found" } });
      return;
    }
    const { course } = resolved;

    const limit = Math.min(Math.max(Number(req.query.limit) || LESSONS_PAGE_SIZE, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const allLessons = await listLessons(deps.pool, course.id);
    const page = allLessons.slice(offset, offset + limit);
    const lessonIds = page.map((l) => l.id);

    // Whop lesson analysis status uses lesson_analyses/analysis_jobs, a
    // separate table pair from project_source_analyses — reuse the
    // existing per-lesson summary counts already computed for the course
    // card instead of introducing a second batched-status query shape.
    const analyzedResult = await deps.pool.query<{ lesson_id: string }>(
      `SELECT DISTINCT lesson_id FROM lesson_analyses WHERE lesson_id = ANY($1) AND status IN ('completed', 'no_strategy')`,
      [lessonIds],
    );
    const analyzedIds = new Set(analyzedResult.rows.map((r) => Number(r.lesson_id)));
    const latestJobResult = await deps.pool.query<{ lesson_id: string; status: string }>(
      `SELECT DISTINCT ON (lesson_id) lesson_id, status FROM analysis_jobs WHERE lesson_id = ANY($1) ORDER BY lesson_id, created_at DESC`,
      [lessonIds],
    );
    const latestJobByLesson = new Map(latestJobResult.rows.map((r) => [Number(r.lesson_id), r.status]));

    const items = page.map((l) => ({
      id: l.id,
      title: l.title,
      chapterTitle: l.chapterTitle,
      sourceUrl: l.sourceUrl,
      durationSeconds: l.durationSeconds,
      status: analyzedIds.has(l.id) ? "ANALYZED" : (latestJobByLesson.get(l.id) ?? "NOT_ANALYZED"),
      eligibleForSynthesis: analyzedIds.has(l.id),
    }));

    res.status(200).json({
      course: await buildWhopProjectSource(deps.pool, course),
      items,
      pagination: { limit, offset, totalCount: allLessons.length },
    });
  };
}
