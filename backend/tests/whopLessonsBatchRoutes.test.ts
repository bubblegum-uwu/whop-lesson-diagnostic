import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { createConnectWhopCourseHandler, createListWhopCoursesHandler, createListWhopCourseLessonsHandler, type WhopCoursesRouteDeps } from "../src/http/routes/whopCourses.js";
import { createBatchAddWhopLessonsHandler, createListAlaCarteWhopLessonsHandler } from "../src/http/routes/whopLessons.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
import { getLessonByWhopLessonId } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
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

async function markLessonAnalyzed(lessonId: number) {
  const jobId = (await pool.query<{ job_id: string }>(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`, [lessonId, randomId("fp")])).rows[0].job_id;
  await createLessonAnalysis(pool, {
    lessonId,
    jobId,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "No strategy.",
    model: "gemini-3.8-flash",
    promptVersion: "v2",
    extractorVersion: "v2",
    schemaVersion: "v2",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 1,
    inputTokens: 1,
    outputTokens: 1,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
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

function callListCourses(projectId: string) {
  const handler = createListWhopCoursesHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callCourseLessons(projectId: string, courseId: string) {
  const handler = createListWhopCourseLessonsHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, courseId }, query: {} } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callListAlaCarte(projectId: string) {
  const handler = createListAlaCarteWhopLessonsHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function lessonUrl(courseId: string, lessonId: string, companySlug = "scarface-trades-mastermind", experienceId = "exp_gdmood6JIzSsE7") {
  return `https://whop.com/${companySlug}/${experienceId}/app/courses/${courseId}/lessons/${lessonId}/`;
}
function courseUrl(courseId: string, companySlug = "scarface-trades-mastermind", experienceId = "exp_gdmood6JIzSsE7") {
  return `https://whop.com/${companySlug}/${experienceId}/app/courses/${courseId}/`;
}

describe("POST /api/projects/:projectId/whop-lessons/batch (Phase 4K follow-up — TRUE à-la-carte Whop import)", () => {
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

  it("CRITICAL — à-la-carte ISOLATION: requesting 1 lesson from a 20-lesson course imports exactly 1 lesson, never the whole course", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const lessonIds = Array.from({ length: 20 }, (_, i) => `lesn_${i + 1}`);
    const client = makeMultiCourseClient({ [courseA]: { title: "Big Course", lessonIds } });

    const { statusCode, body } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_7")], client);
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(1);

    // Not visible as a connected course.
    const { body: coursesBody } = await callListCourses(String(project.id));
    expect((coursesBody.courses as unknown[]).length).toBe(0);
    const courseRow = await getCourseByWhopId(pool, courseA);
    expect(courseRow?.projectId).toBeNull(); // provider metadata exists, but NOT connected to this project

    // Exactly one à-la-carte item, not 20.
    const { body: alaCarteBody } = await callListAlaCarte(String(project.id));
    const items = alaCarteBody.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Lesson lesn_7");

    // All 20 lessons exist as provider metadata (syncCourse needed the whole list to resolve lesson 7)...
    const allLessonsCount = await pool.query(`SELECT COUNT(*) AS count FROM lessons WHERE course_id = $1`, [courseRow!.id]);
    expect(Number((allLessonsCount.rows[0] as { count: string }).count)).toBe(20);
    // ...but the course-lessons browsing endpoint 404s (no connected course to browse) — the other 19 are not analysis candidates for this project.
    const courseLessonsResult = await callCourseLessons(String(project.id), String(courseRow!.id));
    expect(courseLessonsResult.statusCode).toBe(404);
  });

  it("imports multiple individual lessons across DIFFERENT courses, syncing each course exactly once, never connecting either course, never analyzing anything", async () => {
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

    // Neither course is connected — à-la-carte never claims courses.project_id.
    const courseARow = await getCourseByWhopId(pool, courseA);
    const courseBRow = await getCourseByWhopId(pool, courseB);
    expect(courseARow?.projectId).toBeNull();
    expect(courseBRow?.projectId).toBeNull();
    const { body: coursesBody } = await callListCourses(String(project.id));
    expect((coursesBody.courses as unknown[]).length).toBe(0);

    const jobCount = await pool.query(`SELECT COUNT(*) AS count FROM analysis_jobs aj JOIN lessons l ON l.id = aj.lesson_id WHERE l.course_id IN ($1, $2)`, [courseARow!.id, courseBRow!.id]);
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });

  it("BATCH: three requested lessons across multiple courses, plus a duplicate and an unsupported URL — visible items are exactly the three requested", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const courseB = randomId("cors");
    const client = makeMultiCourseClient({
      [courseA]: { title: "Course A", lessonIds: ["lesn_7", "lesn_9"] },
      [courseB]: { title: "Course B", lessonIds: ["lesn_3"] },
    });

    const { statusCode, body } = await callBatch(
      String(project.id),
      [lessonUrl(courseA, "lesn_7"), lessonUrl(courseA, "lesn_9"), lessonUrl(courseB, "lesn_3"), "https://whop.com/not/a/valid/lesson/url", lessonUrl(courseA, "lesn_7")],
      client,
    );
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(3);
    expect(body.duplicateCount).toBe(1);
    expect(body.invalidCount).toBe(1);
    expect((body.results as Array<Record<string, unknown>>).map((r) => r.kind)).toEqual(["added", "added", "added", "invalid", "duplicate"]);

    const { body: alaCarteBody } = await callListAlaCarte(String(project.id));
    const titles = (alaCarteBody.items as Array<Record<string, unknown>>).map((i) => i.title).sort();
    expect(titles).toEqual(["Lesson lesn_3", "Lesson lesn_7", "Lesson lesn_9"]);
  });

  it("a lesson from an already-connected course is recognized as a duplicate without re-syncing, and stays a single catalog item (shown via Connected Courses, not also in à-la-carte)", async () => {
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

    const { body: alaCarteBody } = await callListAlaCarte(String(project.id));
    expect((alaCarteBody.items as unknown[]).length).toBe(0); // it's under Connected Courses, not duplicated here
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
    expect((body.results as Array<Record<string, unknown>>)[0].kind).toBe("invalid");

    const course = await getCourseByWhopId(pool, courseA);
    expect(course?.projectId).toBe(projectA.id); // never reassigned to projectB
  });

  it("cross-project isolation: a lesson already à-la-carted by a DIFFERENT project is reported invalid, never shared", async () => {
    await establishSession();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    await callBatch(String(projectA.id), [lessonUrl(courseA, "lesn_1")], client);

    const { body } = await callBatch(String(projectB.id), [lessonUrl(courseA, "lesn_1")], client);
    expect(body.addedCount).toBe(0);
    expect(body.invalidCount).toBe(1);

    const { body: aliceItems } = await callListAlaCarte(String(projectA.id));
    expect((aliceItems.items as unknown[]).length).toBe(1);
    const { body: bobItems } = await callListAlaCarte(String(projectB.id));
    expect((bobItems.items as unknown[]).length).toBe(0); // project B never inherits project A's membership
  });

  it("REVERSE GUARD: connecting a full course is rejected if one of its lessons was already à-la-carted by a DIFFERENT project", async () => {
    await establishSession();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    await callBatch(String(projectB.id), [lessonUrl(courseA, "lesn_1")], client); // B claims lesson 1 à la carte first

    const { statusCode, body } = await callConnect(String(projectA.id), courseUrl(courseA), client);
    expect(statusCode).toBe(409);
    expect((body.error as Record<string, unknown>).type).toBe("lesson_already_imported_elsewhere");
    const course = await getCourseByWhopId(pool, courseA);
    expect(course?.projectId).toBeNull(); // never connected to A either — reject, don't silently narrow scope
  });

  it("DEDUP à-la-carte → later course (SAME project): lesson is reused, analysis preserved, no longer double-listed", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });

    const { body: batchBody } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1")], client);
    const lessonId = (batchBody.results as Array<Record<string, unknown>>)[0].lesson as Record<string, unknown>;
    await markLessonAnalyzed(lessonId.id as number);

    const { statusCode } = await callConnect(String(project.id), courseUrl(courseA), client);
    expect(statusCode).toBe(201);

    // Same lesson id, no duplicate row.
    const courseRow = await getCourseByWhopId(pool, courseA);
    const lessonCount = await pool.query(`SELECT COUNT(*) AS count FROM lessons WHERE course_id = $1 AND whop_lesson_id = 'lesn_1'`, [courseRow!.id]);
    expect(Number((lessonCount.rows[0] as { count: string }).count)).toBe(1);
    const reusedLesson = await getLessonByWhopLessonId(pool, courseRow!.id, "lesn_1");
    expect(reusedLesson?.id).toBe(lessonId.id);

    // Analysis preserved.
    const analysisStillThere = await pool.query(`SELECT 1 FROM lesson_analyses WHERE lesson_id = $1`, [lessonId.id]);
    expect(analysisStillThere.rows).toHaveLength(1);

    // Now shown via Connected Courses, no longer double-listed à la carte.
    const { body: courseLessonsBody } = await callCourseLessons(String(project.id), String(courseRow!.id));
    expect((courseLessonsBody.items as Array<Record<string, unknown>>).find((i) => i.title === "Lesson lesn_1")).toBeTruthy();
    const { body: alaCarteBody } = await callListAlaCarte(String(project.id));
    expect((alaCarteBody.items as unknown[]).length).toBe(0);
  });

  it("DEDUP course → later à-la-carte (SAME project): duplicate/reused, no duplicate analysis", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1"] } });
    await callConnect(String(project.id), courseUrl(courseA), client);
    const courseRow = await getCourseByWhopId(pool, courseA);
    const lessonRow = await getLessonByWhopLessonId(pool, courseRow!.id, "lesn_1");
    await markLessonAnalyzed(lessonRow!.id);

    const { body } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1")], client);
    expect(body.duplicateCount).toBe(1);
    expect(body.addedCount).toBe(0);

    const analysisCount = await pool.query(`SELECT COUNT(*) AS count FROM lesson_analyses WHERE lesson_id = $1`, [lessonRow!.id]);
    expect(Number((analysisCount.rows[0] as { count: string }).count)).toBe(1); // still exactly one
  });

  it("never analyzes any imported lesson", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1"), lessonUrl(courseA, "lesn_2")], client);

    const courseRow = await getCourseByWhopId(pool, courseA);
    const jobCount = await pool.query(`SELECT COUNT(*) AS count FROM analysis_jobs aj JOIN lessons l ON l.id = aj.lesson_id WHERE l.course_id = $1`, [courseRow!.id]);
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });
});

describe("GET /api/projects/:projectId/whop-lessons (Phase 4K follow-up)", () => {
  it("returns an empty list for a project with no à-la-carte lessons", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callListAlaCarte(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.items).toEqual([]);
  });

  it("returns 404 for an unknown project", async () => {
    const { statusCode } = await callListAlaCarte("999999");
    expect(statusCode).toBe(404);
  });

  it("reflects analyzed/not-analyzed status per item, never a full validated_json payload", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const client = makeMultiCourseClient({ [courseA]: { title: "Course A", lessonIds: ["lesn_1", "lesn_2"] } });
    const { body: batchBody } = await callBatch(String(project.id), [lessonUrl(courseA, "lesn_1"), lessonUrl(courseA, "lesn_2")], client);
    const results = batchBody.results as Array<Record<string, unknown>>;
    const firstLessonId = (results[0].lesson as Record<string, unknown>).id as number;
    await markLessonAnalyzed(firstLessonId);

    const { body } = await callListAlaCarte(String(project.id));
    const items = body.items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.id === firstLessonId)?.status).toBe("ANALYZED");
    expect(items.find((i) => i.id !== firstLessonId)?.status).toBe("NOT_ANALYZED");
    expect(items.some((i) => "validatedJson" in i)).toBe(false);
  });
});
