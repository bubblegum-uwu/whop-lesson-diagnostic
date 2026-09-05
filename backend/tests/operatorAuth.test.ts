import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request, NextFunction } from "express";
import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { requireOperator, type OperatorAuthedRequest } from "../src/http/middleware/operatorAuth.js";
import { createAuthStatusHandler, createDisconnectHandler } from "../src/http/routes/auth.js";
import { createCourseSyncHandler } from "../src/http/routes/courseSync.js";
import { createCourseLessonsHandler } from "../src/http/routes/courseLessons.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { WhopIdentityError, type WhopOAuthClient } from "../src/whop/oauthClient.js";
import type { WhopCourseClient } from "../src/whop/courseClient.js";
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

function makeOAuthClient(overrides: Partial<WhopOAuthClient> = {}): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(), verifyAccessToken: vi.fn(), ...overrides };
}

// ---------------------------------------------------------------------------
// Unit tests: requireOperator in isolation, with fake req/res/next.
// ---------------------------------------------------------------------------

describe("requireOperator middleware", () => {
  it("responds 401 and never calls next() when no Authorization header is present", async () => {
    const oauthClient = makeOAuthClient();
    const middleware = requireOperator({ pool, oauthClient });
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    await middleware({ headers: {} } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "missing_authorization" } });
    expect(next).not.toHaveBeenCalled();
    expect(oauthClient.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("responds 401 when no operator session has ever been established, without calling Whop", async () => {
    const oauthClient = makeOAuthClient();
    const middleware = requireOperator({ pool, oauthClient });
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    await middleware({ headers: { authorization: "Bearer some-token" } } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "auth_required" } });
    expect(next).not.toHaveBeenCalled();
    expect(oauthClient.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("responds 401 when the presented token fails Whop verification", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const oauthClient = makeOAuthClient({
      verifyAccessToken: vi.fn(async () => {
        throw new WhopIdentityError("expired");
      }),
    });
    const middleware = requireOperator({ pool, oauthClient });
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    await middleware({ headers: { authorization: "Bearer expired-token" } } as Request, res, next);

    expect(statusCode()).toBe(401);
    expect(body()).toMatchObject({ error: { type: "invalid_token" } });
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 403 when the verified caller is a different Whop user than the persisted operator", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const oauthClient = makeOAuthClient({ verifyAccessToken: vi.fn(async () => ({ sub: "user_intruder" })) });
    const middleware = requireOperator({ pool, oauthClient });
    const { res, statusCode, body } = makeResponse();
    const next = vi.fn() as NextFunction;

    await middleware({ headers: { authorization: "Bearer intruder-token" } } as Request, res, next);

    expect(statusCode()).toBe(403);
    expect(body()).toMatchObject({ error: { type: "forbidden_operator" } });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and attaches operatorWhopUserId when the verified caller matches the persisted operator", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const oauthClient = makeOAuthClient({ verifyAccessToken: vi.fn(async () => ({ sub: "user_operator" })) });
    const middleware = requireOperator({ pool, oauthClient });
    const { res, statusCode } = makeResponse();
    const next = vi.fn() as NextFunction;
    const req = { headers: { authorization: "Bearer operator-token" } } as OperatorAuthedRequest;

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(statusCode()).toBe(200); // untouched — the middleware itself never writes a success response
    expect(req.operatorWhopUserId).toBe("user_operator");
  });

  it("never includes the caller's raw bearer token in any error response body", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date() }, KEY);
    const secretToken = "super-secret-caller-bearer-token-value";
    const oauthClient = makeOAuthClient({ verifyAccessToken: vi.fn(async () => ({ sub: "user_someone_else" })) });
    const middleware = requireOperator({ pool, oauthClient });
    const { res, body } = makeResponse();

    await middleware({ headers: { authorization: `Bearer ${secretToken}` } } as Request, res, vi.fn() as NextFunction);

    expect(JSON.stringify(body())).not.toContain(secretToken);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a minimal real Express app wiring requireOperator in front of
// every sensitive route, exercised with real HTTP requests.
// ---------------------------------------------------------------------------

function makeCourseClient(): WhopCourseClient {
  return {
    fetchCourse: vi.fn(async (courseId: string) => ({ id: courseId, title: "Course", chapters: [] })),
    fetchCourseLessonsPage: vi.fn(async () => ({ data: [], page_info: { end_cursor: null, has_next_page: false } })),
  };
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestApp(oauthClient: WhopOAuthClient): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const operatorDeps = { pool, oauthClient };
  const authDeps = { pool, oauthClient, refreshTokenEncryptionKey: KEY };

  app.get("/api/auth/status", requireOperator(operatorDeps), createAuthStatusHandler(authDeps));
  app.post("/api/auth/disconnect", requireOperator(operatorDeps), createDisconnectHandler(authDeps));
  app.post(
    "/api/course/sync",
    requireOperator(operatorDeps),
    createCourseSyncHandler({
      pool,
      courseClient: makeCourseClient(),
      oauthClient,
      refreshTokenEncryptionKey: KEY,
      course: { courseId: randomId("cors"), experienceId: "exp_x", slug: "scarface-trades-mastermind" },
    }),
  );
  app.get(
    "/api/course/lessons",
    requireOperator(operatorDeps),
    createCourseLessonsHandler({ pool, whopCourseId: "cors_does_not_matter" }),
  );
  // Stands in for the real analyze-lesson handler: what matters here is
  // whether the request reaches past the gate, not the pipeline itself
  // (that's covered by pipeline.test.ts).
  app.post("/api/analyze-lesson", requireOperator(operatorDeps), (_req, res) => {
    res.status(200).json({ reached: true });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("protected routes end-to-end", () => {
  it("rejects unauthenticated requests to every sensitive route", async () => {
    const server = await startTestApp(makeOAuthClient());
    try {
      const [status, disconnect, sync, lessons, analyze] = await Promise.all([
        fetch(`${server.baseUrl}/api/auth/status`),
        fetch(`${server.baseUrl}/api/auth/disconnect`, { method: "POST" }),
        fetch(`${server.baseUrl}/api/course/sync`, { method: "POST" }),
        fetch(`${server.baseUrl}/api/course/lessons`),
        fetch(`${server.baseUrl}/api/analyze-lesson`, { method: "POST" }),
      ]);
      expect(status.status).toBe(401);
      expect(disconnect.status).toBe(401);
      expect(sync.status).toBe(401);
      expect(lessons.status).toBe(401);
      expect(analyze.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("a verified, matching operator reaches the real handler on every protected route", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }, KEY);
    const oauthClient = makeOAuthClient({ verifyAccessToken: vi.fn(async () => ({ sub: "user_operator" })) });
    const server = await startTestApp(oauthClient);
    const headers = { Authorization: "Bearer operator-token" };
    try {
      const status = await fetch(`${server.baseUrl}/api/auth/status`, { headers });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ connected: true });

      const lessons = await fetch(`${server.baseUrl}/api/course/lessons`, { headers });
      expect(lessons.status).toBe(200);

      const analyze = await fetch(`${server.baseUrl}/api/analyze-lesson`, { method: "POST", headers });
      expect(analyze.status).toBe(200);
      expect(await analyze.json()).toEqual({ reached: true });
    } finally {
      await server.close();
    }
  });

  it("a verified but different Whop user gets 403 on every protected route, never reaching the handler", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }, KEY);
    const oauthClient = makeOAuthClient({ verifyAccessToken: vi.fn(async () => ({ sub: "user_intruder" })) });
    const server = await startTestApp(oauthClient);
    const headers = { Authorization: "Bearer intruder-token" };
    try {
      const [status, lessons, analyze] = await Promise.all([
        fetch(`${server.baseUrl}/api/auth/status`, { headers }),
        fetch(`${server.baseUrl}/api/course/lessons`, { headers }),
        fetch(`${server.baseUrl}/api/analyze-lesson`, { method: "POST", headers }),
      ]);
      expect(status.status).toBe(403);
      expect(lessons.status).toBe(403);
      expect(analyze.status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
