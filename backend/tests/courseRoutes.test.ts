import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { createCourseSyncHandler } from "../src/http/routes/courseSync.js";
import { createCourseLessonsHandler } from "../src/http/routes/courseLessons.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
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

function makeCourseClient(): WhopCourseClient {
  return {
    fetchCourse: vi.fn(async (courseId: string) => ({
      id: courseId,
      title: "Scarface Trades Mastermind",
      chapters: [{ id: "chap_1", title: "Foundations", order: 1, lessons: [{ id: "lesn_a", order: 1 }] }],
    })),
    fetchCourseLessonsPage: vi.fn(async () => ({
      data: [
        {
          id: "lesn_a",
          title: "Intro",
          order: 1,
          lesson_type: "video",
          visibility: "visible",
          video_asset: { duration_seconds: 900, status: "ready" },
        },
      ],
      page_info: { end_cursor: null, has_next_page: false },
    })),
  };
}

function makeOAuthClient(): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(), verifyAccessToken: vi.fn() };
}

describe("POST /api/course/sync", () => {
  it("returns 401 auth_required when no Whop session has been established", async () => {
    const courseId = randomId("cors");
    const handler = createCourseSyncHandler({
      pool,
      courseClient: makeCourseClient(),
      oauthClient: makeOAuthClient(),
      refreshTokenEncryptionKey: KEY,
      course: { courseId, experienceId: "exp_x", slug: "scarface-trades-mastermind" },
    });
    const { res, statusCode, body } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "auth_required" } });
  });

  it("syncs and returns a summary when a valid session exists", async () => {
    const courseId = randomId("cors");
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "fresh-token", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
      KEY,
    );
    const handler = createCourseSyncHandler({
      pool,
      courseClient: makeCourseClient(),
      oauthClient: makeOAuthClient(),
      refreshTokenEncryptionKey: KEY,
      course: { courseId, experienceId: "exp_x", slug: "scarface-trades-mastermind" },
    });
    const { res, statusCode, body } = makeResponse();

    await handler({} as Request, res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ courseTitle: "Scarface Trades Mastermind", upserted: 1, archived: 0 });
  });
});

describe("GET /api/course/lessons", () => {
  it("returns an empty course/lessons pair before any sync has run", async () => {
    const handler = createCourseLessonsHandler({ pool, whopCourseId: randomId("cors") });
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect(body()).toEqual({ course: null, lessons: [] });
  });

  it("returns persisted lessons shaped for the Course table, after a sync", async () => {
    const courseId = randomId("cors");
    await saveAuthSession(
      pool,
      { whopUserId: "user_1", accessToken: "fresh-token", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
      KEY,
    );
    const syncHandler = createCourseSyncHandler({
      pool,
      courseClient: makeCourseClient(),
      oauthClient: makeOAuthClient(),
      refreshTokenEncryptionKey: KEY,
      course: { courseId, experienceId: "exp_gdmood6JIzSsE7", slug: "scarface-trades-mastermind" },
    });
    await syncHandler({} as Request, makeResponse().res);

    const lessonsHandler = createCourseLessonsHandler({ pool, whopCourseId: courseId });
    const { res, body } = makeResponse();
    await lessonsHandler({} as Request, res);

    const result = body() as { course: { title: string }; lessons: Array<{ title: string; sourceUrl: string }> };
    expect(result.course.title).toBe("Scarface Trades Mastermind");
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].title).toBe("Intro");
    expect(result.lessons[0].sourceUrl).toContain(`/courses/${courseId}/lessons/lesn_a/`);
  });
});
