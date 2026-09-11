import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { createBatchAddWhopLessonsHandler, createConnectWhopCourseHandler, type WhopCoursesRouteDeps } from "../src/http/routes/whopCourses.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { getLessonByWhopLessonId } from "../src/db/lessonsRepo.js";
import type { WhopCourseClient } from "../src/whop/courseClient.js";
import type { WhopOAuthClient } from "../src/whop/oauthClient.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const KEY = randomBytes(32).toString("base64");

afterEach(async () => {
  await deleteAuthSession(pool);
});
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function establishSession() {
  await saveAuthSession(pool, { whopUserId: "user_1", accessToken: "fresh-token", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }, KEY);
}

/** One fake course client shared across every course referenced in a test's URLs — keyed by courseId so distinct courses return distinct lesson sets. */
function makeMultiCourseClient(courses: Record<string, { title: string; lessonIds: string[] }>): WhopCourseClient {
  return {
    fetchCourse: vi.fn(async (courseId: string) => ({ id: courseId, title: courses[courseId]?.title ?? "Unknown", chapters: [] })),
    fetchCourseLessonsPage: vi.fn(async (courseId: string) => ({
      data: (courses[courseId]?.lessonIds ?? []).map((id, i) => ({ id, title: `Lesson ${id}`, order: i + 1, lesson_type: "video", visibility: "visible", video_asset: null })),
      page_info: { end_cursor: null, has_next_page: false },
    })),
  };
}

function makeOAuthClient(): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(), verifyAccessToken: vi.fn() };
}

function deps(courseClient: WhopCourseClient): WhopCoursesRouteDeps {
  return { pool, courseClient, oauthClient: makeOAuthClient(), refreshTokenEncryptionKey: KEY };
}

function callBatch(projectId: string, urls: unknown, courseClient: WhopCourseClient) {
  const handler = createBatchAddWhopLessonsHandler(deps(courseClient));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { urls } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callConnect(projectId: string, courseUrl: string, courseClient: WhopCourseClient) {
  const handler = createConnectWhopCourseHandler(deps(courseClient));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { courseUrl } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function lessonUrl(courseId: string, lessonId: string, companySlug = "scarface-trades-mastermind", experienceId = "exp_gdmood6JIzSsE7") {
  return `https://whop.com/${companySlug}/${experienceId}/app/courses/${courseId}/lessons/${lessonId}/`;
}
function courseUrl(courseId: string, companySlug = "scarface-trades-mastermind", experienceId = "exp_gdmood6JIzSsE7") {
  return `https://whop.com/${companySlug}/${experienceId}/app/courses/${courseId}/`;
}

describe("POST /api/projects/:projectId/whop-lessons/batch (Phase 4K follow-up — à-la-carte Whop import)", () => {
  it("returns 401 auth_required when no Whop session has been established", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callBatch(String(project.id), [lessonUrl("cors_x", "lesn_a")], makeMultiCourseClient({}));
    expect(statusCode).toBe(401);
    expect((body.error as Record<string, unknown>).type).toBe("auth_required");
  });

  it("rejects an empty or non-array urls body with 400", async () => {
    await establishSession();
    const project = await makeProject();
    const client = makeMultiCourseClient({});
    expect((await callBatch(String(project.id), [], client)).statusCode).toBe(400);
    expect((await callBatch(String(project.id), "not-an-array", client)).statusCode).toBe(400);
  });

  it("imports multiple individual lessons across DIFFERENT courses, syncing each course exactly once, never analyzing anything", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const courseB = randomId("cors");
    const client = makeMultiCourseClient({
      [courseA]: { title: "Course A", lessonIds: ["lesn_a1", "lesn_a2"] },
      [courseB]: { title: "Course B", lessonIds: ["lesn_b1"] },
    });

    const { statusCode, body } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_a1"), lessonUrl(courseB, "lesn_b1")], client);
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(2);
    expect(body.duplicateCount).toBe(0);
    expect(body.invalidCount).toBe(0);
    const results = body.results as Array<Record<string, unknown>>;
    expect((results[0].lesson as Record<string, unknown>).courseTitle).toBe("Course A");
    expect((results[1].lesson as Record<string, unknown>).courseTitle).toBe("Course B");

    expect(client.fetchCourse).toHaveBeenCalledTimes(2);

    const jobCount = await pool.query(`SELECT COUNT(*) AS count FROM analysis_jobs aj JOIN lessons l ON l.id = aj.lesson_id WHERE l.course_id IN (SELECT id FROM courses WHERE project_id = $1)`, [project.id]);
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);

    const courseARow = await getCourseByWhopId(pool, courseA);
    expect(courseARow?.projectId).toBe(project.id);
  });

  it("multiple lesson URLs from the SAME course sync that course only once, and both lessons import from it (example: 3 valid, 1 duplicate, 1 unsupported)", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2", "lesn_3"] } });

    const { statusCode, body } = await callBatch(
      String(project.id),
      [
        lessonUrl(courseA, "lesn_1"),
        lessonUrl(courseA, "lesn_2"), // same course as above — must not re-sync
        lessonUrl(courseA, "lesn_1"), // exact repeat within the same batch — duplicate
        "https://whop.com/not/a/valid/lesson/url",
        lessonUrl(courseA, "lesn_nonexistent"), // parses fine, but the course doesn't actually contain this lesson
      ],
      client,
    );
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(2);
    expect(body.duplicateCount).toBe(1);
    expect(body.invalidCount).toBe(2);
    expect(client.fetchCourse).toHaveBeenCalledTimes(1); // synced once, not once per URL

    const results = body.results as Array<Record<string, unknown>>;
    expect(results.map((r) => r.kind)).toEqual(["added", "added", "duplicate", "invalid", "invalid"]);
  });

  it("a lesson from an already-connected course is recognized as a duplicate without re-syncing", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    await callConnect(String(project.id), courseUrl(courseA), client);
    vi.clearAllMocks();

    const { body } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1")], client);
    expect(body.addedCount).toBe(0);
    expect(body.duplicateCount).toBe(1);
    expect(client.fetchCourse).not.toHaveBeenCalled();
  });

  it("existing course lesson is REUSED, never duplicated in the lessons table", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1"] } });
    await callConnect(String(project.id), courseUrl(courseA), client);

    const before = await getCourseByWhopId(pool, courseA);
    const beforeLesson = await getLessonByWhopLessonId(pool, before!.id, "lesn_1");

    await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1")], client);

    const lessonCount = await pool.query(`SELECT COUNT(*) AS count FROM lessons WHERE course_id = $1 AND whop_lesson_id = $2`, [before!.id, "lesn_1"]);
    expect(Number((lessonCount.rows[0] as { count: string }).count)).toBe(1);
    const afterLesson = await getLessonByWhopLessonId(pool, before!.id, "lesn_1");
    expect(afterLesson?.id).toBe(beforeLesson?.id);
  });

  it("cross-project isolation: a lesson whose course is already connected to a DIFFERENT project is reported invalid, never stolen", async () => {
    await establishSession();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1"] } });
    await callConnect(String(projectA.id), courseUrl(courseA), client);

    const { body } = await callBatch(String(projectB.id), [lessonUrl(courseA, "lesn_1")], client);
    expect(body.addedCount).toBe(0);
    expect(body.invalidCount).toBe(1);
    const results = body.results as Array<Record<string, unknown>>;
    expect(results[0].kind).toBe("invalid");

    const course = await getCourseByWhopId(pool, courseA);
    expect(course?.projectId).toBe(projectA.id); // never reassigned to projectB
  });

  it("never analyzes any imported lesson", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1"), lessonUrl(courseA, "lesn_2")], client);

    const jobCount = await pool.query(`SELECT COUNT(*) AS count FROM analysis_jobs aj JOIN lessons l ON l.id = aj.lesson_id WHERE l.course_id IN (SELECT id FROM courses WHERE project_id = $1)`, [project.id]);
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });
});
