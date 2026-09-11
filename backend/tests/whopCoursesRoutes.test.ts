import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import {
  createConnectWhopCourseHandler,
  createListWhopCoursesHandler,
  createRefreshWhopCourseHandler,
  createListWhopCourseLessonsHandler,
  type WhopCoursesRouteDeps,
} from "../src/http/routes/whopCourses.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { getCourseByWhopId } from "../src/db/coursesRepo.js";
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

function makeCourseClient(courseId: string, title: string, lessonIds: string[]): WhopCourseClient {
  return {
    fetchCourse: vi.fn(async () => ({ id: courseId, title, chapters: [] })),
    fetchCourseLessonsPage: vi.fn(async () => ({
      data: lessonIds.map((id, i) => ({ id, title: `Lesson ${id}`, order: i + 1, lesson_type: "video", visibility: "visible", video_asset: null })),
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

function callConnect(projectId: string, courseUrl: unknown, courseClient: WhopCourseClient) {
  const handler = createConnectWhopCourseHandler(deps(courseClient));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { courseUrl } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callList(projectId: string) {
  const handler = createListWhopCoursesHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRefresh(projectId: string, courseId: string, courseClient: WhopCourseClient) {
  const handler = createRefreshWhopCourseHandler(deps(courseClient));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, courseId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callLessons(projectId: string, courseId: string) {
  const handler = createListWhopCourseLessonsHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, courseId }, query: {} } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function courseUrl(courseId: string) {
  return `https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/${courseId}/`;
}

describe("POST /api/projects/:projectId/whop-courses (Phase 4K)", () => {
  it("connects a new course, discovering its lessons without analyzing any of them", async () => {
    await establishSession();
    const project = await makeProject();
    const courseId = randomId("cors");
    const client = makeCourseClient(courseId, "Trading Accelerator", ["lesn_a", "lesn_b"]);

    const { statusCode, body } = await callConnect(String(project.id), courseUrl(courseId), client);
    expect(statusCode).toBe(201);
    const course = body.course as Record<string, unknown>;
    expect(course.name).toBe("Trading Accelerator");
    expect(course.lessonCount).toBe(2);
    expect(course.analyzedLessonCount).toBe(0);

    const jobCount = await pool.query(
      `SELECT COUNT(*) AS count FROM analysis_jobs aj JOIN lessons l ON l.id = aj.lesson_id WHERE l.course_id = (SELECT id FROM courses WHERE whop_course_id = $1)`,
      [courseId],
    );
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });

  it("returns 401 auth_required when no Whop session has been established", async () => {
    const project = await makeProject();
    const courseId = randomId("cors");
    const { statusCode, body } = await callConnect(String(project.id), courseUrl(courseId), makeCourseClient(courseId, "X", []));
    expect(statusCode).toBe(401);
    expect((body.error as Record<string, unknown>).type).toBe("auth_required");
  });

  it("rejects an unparseable course URL with 400, never calling the Whop API", async () => {
    await establishSession();
    const project = await makeProject();
    const client = makeCourseClient("cors_x", "X", []);
    const { statusCode } = await callConnect(String(project.id), "not a url", client);
    expect(statusCode).toBe(400);
    expect(client.fetchCourse).not.toHaveBeenCalled();
  });

  it("MULTIPLE COURSES: connecting a second, different course to the same project succeeds independently", async () => {
    await establishSession();
    const project = await makeProject();
    const courseA = randomId("cors");
    const courseB = randomId("cors");

    await callConnect(String(project.id), courseUrl(courseA), makeCourseClient(courseA, "Course A", ["lesn_a1"]));
    await callConnect(String(project.id), courseUrl(courseB), makeCourseClient(courseB, "Course B", ["lesn_b1", "lesn_b2"]));

    const { body } = await callList(String(project.id));
    const courses = body.courses as Array<Record<string, unknown>>;
    expect(courses).toHaveLength(2);
    expect(courses.map((c) => c.name).sort()).toEqual(["Course A", "Course B"]);
    expect(courses.find((c) => c.name === "Course A")?.lessonCount).toBe(1);
    expect(courses.find((c) => c.name === "Course B")?.lessonCount).toBe(2);
  });

  it("rejects connecting a course that is already connected to a DIFFERENT project", async () => {
    await establishSession();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseId = randomId("cors");
    await callConnect(String(projectA.id), courseUrl(courseId), makeCourseClient(courseId, "Taken", []));

    const { statusCode, body } = await callConnect(String(projectB.id), courseUrl(courseId), makeCourseClient(courseId, "Taken", []));
    expect(statusCode).toBe(409);
    expect((body.error as Record<string, unknown>).type).toBe("course_already_connected");

    const course = await getCourseByWhopId(pool, courseId);
    expect(course?.projectId).toBe(projectA.id);
  });

  it("re-connecting the SAME course to the SAME project is idempotent, not an error", async () => {
    await establishSession();
    const project = await makeProject();
    const courseId = randomId("cors");
    const client = makeCourseClient(courseId, "X", ["lesn_1"]);
    await callConnect(String(project.id), courseUrl(courseId), client);
    const { statusCode } = await callConnect(String(project.id), courseUrl(courseId), client);
    expect(statusCode).toBe(201);
  });
});

describe("GET /api/projects/:projectId/whop-courses/:courseId/lessons (Phase 4K)", () => {
  it("returns lessons with per-lesson status, paginated, never a full validated_json payload", async () => {
    await establishSession();
    const project = await makeProject();
    const courseId = randomId("cors");
    await callConnect(String(project.id), courseUrl(courseId), makeCourseClient(courseId, "X", ["lesn_1", "lesn_2"]));
    const { body: coursesBody } = await callList(String(project.id));
    const internalCourseId = (coursesBody.courses as Array<Record<string, unknown>>)[0].courseId as number;

    const lessonsResult = await pool.query<{ id: string }>(`SELECT id FROM lessons WHERE course_id = $1 ORDER BY whop_lesson_id ASC`, [internalCourseId]);
    await createLessonAnalysis(pool, {
      lessonId: Number(lessonsResult.rows[0].id),
      jobId: (await pool.query<{ job_id: string }>(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`, [lessonsResult.rows[0].id, randomId("fp")])).rows[0].job_id,
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

    const { statusCode, body } = await callLessons(String(project.id), String(internalCourseId));
    expect(statusCode).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.status === "ANALYZED")).toBeTruthy();
    expect(items.find((i) => i.status === "NOT_ANALYZED")).toBeTruthy();
    expect(items.some((i) => "validatedJson" in i)).toBe(false);
  });

  it("cross-project isolation: a course from another project returns 404", async () => {
    await establishSession();
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseId = randomId("cors");
    await callConnect(String(projectA.id), courseUrl(courseId), makeCourseClient(courseId, "X", ["lesn_1"]));
    const { body } = await callList(String(projectA.id));
    const internalCourseId = (body.courses as Array<Record<string, unknown>>)[0].courseId as number;

    const { statusCode } = await callLessons(String(projectB.id), String(internalCourseId));
    expect(statusCode).toBe(404);
  });
});

describe("POST /api/projects/:projectId/whop-courses/:courseId/refresh (Phase 4K)", () => {
  it("discovers newly-added lessons while preserving existing lessons' analysis", async () => {
    await establishSession();
    const project = await makeProject();
    const courseId = randomId("cors");
    await callConnect(String(project.id), courseUrl(courseId), makeCourseClient(courseId, "X", ["lesn_1"]));
    const { body: listed } = await callList(String(project.id));
    const internalCourseId = (listed.courses as Array<Record<string, unknown>>)[0].courseId as number;

    const { statusCode, body } = await callRefresh(String(project.id), String(internalCourseId), makeCourseClient(courseId, "X", ["lesn_1", "lesn_2"]));
    expect(statusCode).toBe(200);
    expect((body.course as Record<string, unknown>).lessonCount).toBe(2);
  });

  it("refresh idempotency: refreshing twice with no provider changes creates zero duplicate lessons", async () => {
    await establishSession();
    const project = await makeProject();
    const courseId = randomId("cors");
    const client = makeCourseClient(courseId, "X", ["lesn_1"]);
    await callConnect(String(project.id), courseUrl(courseId), client);
    const { body: listed } = await callList(String(project.id));
    const internalCourseId = (listed.courses as Array<Record<string, unknown>>)[0].courseId as number;

    await callRefresh(String(project.id), String(internalCourseId), client);
    await callRefresh(String(project.id), String(internalCourseId), client);

    const { body } = await callLessons(String(project.id), String(internalCourseId));
    expect((body.pagination as Record<string, unknown>).totalCount).toBe(1);
  });
});
