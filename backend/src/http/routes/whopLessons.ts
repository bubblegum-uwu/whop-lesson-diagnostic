import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getCourseByWhopId, type CourseRow } from "../../db/coursesRepo.js";
import { getLessonByWhopLessonId } from "../../db/lessonsRepo.js";
import { createWhopLessonImport, listAlaCarteWhopLessonsByProjectId } from "../../db/whopLessonImportsRepo.js";
import { getWhopLessonAnalysisStatus } from "../../db/whopLessonAnalysisStatusRepo.js";
import { syncCourse, type CourseSyncConfig } from "../../pipeline/courseSync.js";
import { resolveAccessToken, type WhopCoursesRouteDeps } from "./whopCourses.js";
import { parseWhopLessonUrl, WhopUrlParseError } from "../../lib/whopUrl.js";
import { globalRedactor } from "../../lib/redact.js";

const NOT_FOUND_PROJECT = { error: { message: "Unknown project.", type: "project_not_found" } } as const;

interface BatchAddWhopLessonsBody {
  urls?: unknown;
}

export type WhopLessonBatchResultKind = "added" | "duplicate" | "invalid";
export interface WhopLessonBatchResultEntry {
  url: string;
  kind: WhopLessonBatchResultKind;
  lesson?: { id: number; title: string; courseId: number; courseTitle: string; sourceUrl: string };
  message?: string;
}
export interface WhopLessonBatchResponse {
  results: WhopLessonBatchResultEntry[];
  addedCount: number;
  duplicateCount: number;
  invalidCount: number;
}

const MAX_BATCH_WHOP_LESSON_URLS = 50;

function summarizeWhopLessonBatch(results: WhopLessonBatchResultEntry[]): WhopLessonBatchResponse {
  return {
    results,
    addedCount: results.filter((r) => r.kind === "added").length,
    duplicateCount: results.filter((r) => r.kind === "duplicate").length,
    invalidCount: results.filter((r) => r.kind === "invalid").length,
  };
}

/**
 * POST /api/projects/:projectId/whop-lessons/batch — Phase 4K follow-up:
 * TRUE à-la-carte Whop lesson import. Fixes a product-semantic bug in the
 * original implementation, which resolved a lesson URL by calling
 * syncCourse and then claiming the ENTIRE course to the requesting
 * project — silently exposing every OTHER lesson in that course as a
 * "connected" project item for a user who only pasted one URL.
 *
 * The fix, per the 1789900000000_whop-ala-carte-lessons.sql migration:
 *   - syncCourse still runs when needed to resolve the lesson (Whop's API
 *     can only resolve a lesson via its course's lesson-list endpoint) —
 *     but this ONLY upserts shared `courses`/`lessons` PROVIDER METADATA.
 *     It never claims `courses.project_id` here (contrast with
 *     createConnectWhopCourseHandler, which does, deliberately, for an
 *     explicit full-course connect).
 *   - ONLY the specifically requested lesson gets a
 *     project_whop_lesson_imports row — that row (not the mere existence
 *     of a `lessons` record) is what makes a lesson visible in THIS
 *     project's à-la-carte catalog (see createListAlaCarteWhopLessonsHandler
 *     below). The course's other lessons stay inert metadata: not shown
 *     in this project's catalog, not analyzable, not a future synthesis
 *     candidate, and the course itself does NOT appear under "Connected
 *     Courses" (GET /whop-courses) merely because one of its lessons was
 *     pasted.
 *
 * Deduplication (spec section 4): if the lesson's course is ALREADY fully
 * connected to this project, the lesson is already visible via that path
 * — reported "duplicate", no redundant membership row written. If the
 * lesson already has an à-la-carte membership row for this SAME project
 * (a repeat URL, whether earlier in this same batch or from a previous
 * call), also "duplicate" — the row itself is the source of truth, not an
 * in-memory "seen it this batch" set. If the lesson is already owned
 * (either via full connection or à-la-carte) by a DIFFERENT project,
 * "invalid" — never silently reassigned/shared (project_whop_lesson_imports.lesson_id
 * is a primary key: a lesson has at most one owning project, ever).
 *
 * Never analyzes anything — syncCourse only ever upserts
 * `courses`/`lessons` metadata, exactly like "Connect Course".
 */
export function createBatchAddWhopLessonsHandler(deps: WhopCoursesRouteDeps) {
  return async function batchAddWhopLessonsHandler(req: Request, res: Response): Promise<void> {
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

    const body = req.body as BatchAddWhopLessonsBody;
    if (!Array.isArray(body?.urls) || body.urls.length === 0) {
      res.status(400).json({ error: { message: "urls must be a non-empty array.", type: "invalid_request" } });
      return;
    }
    if (body.urls.length > MAX_BATCH_WHOP_LESSON_URLS) {
      res.status(400).json({ error: { message: `At most ${MAX_BATCH_WHOP_LESSON_URLS} URLs per batch.`, type: "invalid_request" } });
      return;
    }
    if (!body.urls.every((u): u is string => typeof u === "string")) {
      res.status(400).json({ error: { message: "Every entry in urls must be a string.", type: "invalid_request" } });
      return;
    }
    const urls = body.urls;

    const accessToken = await resolveAccessToken(deps, res);
    if (accessToken === null) return;

    const results: WhopLessonBatchResultEntry[] = [];
    const syncedCourseWhopIds = new Set<string>();
    const courseRowCache = new Map<string, CourseRow>();

    async function getCachedCourse(whopCourseId: string): Promise<CourseRow | null> {
      const cached = courseRowCache.get(whopCourseId);
      if (cached) return cached;
      const row = await getCourseByWhopId(deps.pool, whopCourseId);
      if (row) courseRowCache.set(whopCourseId, row);
      return row;
    }

    for (const url of urls) {
      let parsed;
      try {
        parsed = parseWhopLessonUrl(url);
      } catch (err) {
        results.push({ url, kind: "invalid", message: err instanceof WhopUrlParseError ? err.message : "Could not parse this Whop lesson URL." });
        continue;
      }

      let courseRow = await getCachedCourse(parsed.courseId);
      if (courseRow && courseRow.projectId != null && courseRow.projectId !== projectId) {
        results.push({ url, kind: "invalid", message: "This lesson's course is already connected to a different project." });
        continue;
      }

      let lesson = courseRow ? await getLessonByWhopLessonId(deps.pool, courseRow.id, parsed.lessonId) : null;

      if (!lesson && !syncedCourseWhopIds.has(parsed.courseId)) {
        const config: CourseSyncConfig = { courseId: parsed.courseId, experienceId: parsed.experienceId, slug: parsed.companySlug };
        try {
          // Provider-metadata sync only — deliberately NEVER claims
          // courses.project_id here (contrast createConnectWhopCourseHandler).
          await syncCourse(deps.pool, deps.courseClient, accessToken, config);
        } catch (err) {
          const safeMessage = globalRedactor.redact(err instanceof Error ? err.message : "Could not sync this lesson's course.");
          results.push({ url, kind: "invalid", message: safeMessage });
          continue;
        }
        syncedCourseWhopIds.add(parsed.courseId);
        courseRow = await getCourseByWhopId(deps.pool, parsed.courseId);
        if (!courseRow) {
          results.push({ url, kind: "invalid", message: "This lesson's course could not be synced." });
          continue;
        }
        courseRowCache.set(parsed.courseId, courseRow);
        lesson = await getLessonByWhopLessonId(deps.pool, courseRow.id, parsed.lessonId);
      }

      if (!lesson) {
        results.push({ url, kind: "invalid", message: "This lesson could not be found in its Whop course." });
        continue;
      }

      // Already visible via a full course connection to THIS project — no
      // redundant membership row needed (the à-la-carte listing excludes
      // it anyway, since it's already shown under Connected Courses).
      if (courseRow!.projectId === projectId) {
        results.push({ url, kind: "duplicate", lesson: { id: lesson.id, title: lesson.title, courseId: courseRow!.id, courseTitle: courseRow!.title, sourceUrl: lesson.sourceUrl } });
        continue;
      }

      const { importRow, created } = await createWhopLessonImport(deps.pool, projectId, lesson.id);
      if (!created && importRow.projectId !== projectId) {
        results.push({ url, kind: "invalid", message: "This lesson is already imported into a different project." });
        continue;
      }
      results.push({
        url,
        kind: created ? "added" : "duplicate",
        lesson: { id: lesson.id, title: lesson.title, courseId: courseRow!.id, courseTitle: courseRow!.title, sourceUrl: lesson.sourceUrl },
      });
    }

    res.status(200).json(summarizeWhopLessonBatch(results));
  };
}

export interface AlaCarteWhopLessonSummary {
  id: number;
  title: string;
  courseId: number;
  courseTitle: string;
  sourceUrl: string;
  durationSeconds: number | null;
  status: string;
  eligibleForSynthesis: boolean;
}

/**
 * GET /api/projects/:projectId/whop-lessons — this project's à-la-carte
 * Whop lessons (never a full course's worth — see
 * createBatchAddWhopLessonsHandler above), status-only (never
 * validated_json). Excludes any lesson whose course has since become
 * fully connected to this SAME project (whopLessonImportsRepo.listAlaCarteWhopLessonsByProjectId's
 * own doc comment) so a lesson is never shown in both this list and the
 * Connected Courses view at once.
 */
export function createListAlaCarteWhopLessonsHandler(deps: { pool: Pool }) {
  return async function listAlaCarteWhopLessonsHandler(req: Request, res: Response): Promise<void> {
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

    const rows = await listAlaCarteWhopLessonsByProjectId(deps.pool, projectId);
    const statusByLesson = await getWhopLessonAnalysisStatus(deps.pool, rows.map((r) => r.lessonId));

    const items: AlaCarteWhopLessonSummary[] = rows.map((row) => {
      const entry = statusByLesson.get(row.lessonId) ?? { status: "NOT_ANALYZED", eligibleForSynthesis: false };
      return {
        id: row.lessonId,
        title: row.title,
        courseId: row.courseId,
        courseTitle: row.courseTitle,
        sourceUrl: row.sourceUrl,
        durationSeconds: row.durationSeconds,
        status: entry.status,
        eligibleForSynthesis: entry.eligibleForSynthesis,
      };
    });

    res.status(200).json({ projectId, items });
  };
}
