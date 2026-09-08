import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { requireKnoveraAuth } from "../src/http/middleware/knoveraAuth.js";
import { requireWhopConnected } from "../src/http/middleware/whopConnected.js";
import { createDisconnectHandler } from "../src/http/routes/auth.js";
import { createListProjectsHandler, createGetProjectHandler } from "../src/http/routes/projects.js";
import { createGetProjectSourcesHandler } from "../src/http/routes/projectSources.js";
import { createCourseLessonsHandler } from "../src/http/routes/courseLessons.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, type SyncLessonInput } from "../src/db/lessonsRepo.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import type { WhopOAuthClient } from "../src/whop/oauthClient.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const SECRET = "test-knovera-integration-secret";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 bytes, base64 — encryption key for auth_sessions in these tests

afterEach(async () => {
  await deleteAuthSession(pool);
});
afterAll(async () => {
  await pool.end();
});

function makeOAuthClient(overrides: Partial<WhopOAuthClient> = {}): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(), verifyAccessToken: vi.fn(), ...overrides };
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestApp(oauthClient: WhopOAuthClient): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const knoveraAuth = requireKnoveraAuth({ authSecret: SECRET });
  const whopConnected = requireWhopConnected({ pool });
  const authDeps = { pool, oauthClient, refreshTokenEncryptionKey: KEY, whopOperatorUserId: "user_operator", jobTrigger: undefined };
  const projectsDeps = { pool };

  app.get("/api/projects", knoveraAuth, createListProjectsHandler(projectsDeps));
  app.get("/api/projects/:projectId", knoveraAuth, createGetProjectHandler(projectsDeps));
  app.get("/api/projects/:projectId/sources", knoveraAuth, createGetProjectSourcesHandler(projectsDeps));
  app.get("/api/course/lessons", knoveraAuth, createCourseLessonsHandler({ pool, whopCourseId: "cors_placeholder_never_matches" }));
  app.post("/api/auth/disconnect", knoveraAuth, createDisconnectHandler(authDeps));
  // Stands in for the real courseSync handler: what matters here is whether
  // the request reaches past requireWhopConnected, not the sync pipeline
  // itself (that's covered by courseSync.ts's own tests).
  app.post("/api/course/sync", knoveraAuth, whopConnected, (_req, res) => {
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

function lesson(overrides: Partial<SyncLessonInput> = {}): SyncLessonInput {
  return {
    whopLessonId: randomId("lesn"),
    title: "Support & Resistance",
    lessonType: "video",
    visibility: "visible",
    chapterWhopId: "chap_1",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 2640,
    videoAssetStatus: "ready",
    videoAvailable: true,
    sourceUrl: "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_x/lessons/lesn_x/",
    ...overrides,
  };
}

describe("Phase 4D — Knovera auth vs Whop provider auth, end to end", () => {
  it("J/K/L: GET /api/projects, /:id, and /:id/sources all succeed with a valid Knovera token and NO Whop connection at all", async () => {
    const server = await startTestApp(makeOAuthClient());
    const headers = { Authorization: `Bearer ${issueKnoveraToken(SECRET)}` };
    try {
      const projectsRes = await fetch(`${server.baseUrl}/api/projects`, { headers });
      expect(projectsRes.status).toBe(200);
      const { projects } = (await projectsRes.json()) as { projects: { id: number }[] };
      expect(projects.length).toBeGreaterThan(0);
      const projectId = projects[0].id;

      const oneRes = await fetch(`${server.baseUrl}/api/projects/${projectId}`, { headers });
      expect(oneRes.status).toBe(200);

      const sourcesRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/sources`, { headers });
      expect(sourcesRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("M: previously-synced lesson data remains readable through Knovera auth with Whop disconnected", async () => {
    const server = await startTestApp(makeOAuthClient());
    const headers = { Authorization: `Bearer ${issueKnoveraToken(SECRET)}` };
    try {
      const course = await upsertCourse(pool, {
        whopCourseId: "cors_placeholder_never_matches",
        whopExperienceId: "exp_x",
        slug: "scarface-trades-mastermind",
        title: "Scarface Trades Mastermind",
      });
      await syncLessons(pool, course.id, [lesson(), lesson()]);

      const res = await fetch(`${server.baseUrl}/api/course/lessons`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { lessons: unknown[] };
      expect(body.lessons.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("N: a Whop-specific sync attempt with no Whop connection returns a deterministic 409 WHOP_NOT_CONNECTED, never a Knovera auth failure", async () => {
    const server = await startTestApp(makeOAuthClient());
    const headers = { Authorization: `Bearer ${issueKnoveraToken(SECRET)}` };
    try {
      const res = await fetch(`${server.baseUrl}/api/course/sync`, { method: "POST", headers });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ error: { type: "WHOP_NOT_CONNECTED" } });
    } finally {
      await server.close();
    }
  });

  it("N: once Whop is connected, the same sync route reaches the real handler", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }, KEY);
    const server = await startTestApp(makeOAuthClient());
    const headers = { Authorization: `Bearer ${issueKnoveraToken(SECRET)}` };
    try {
      const res = await fetch(`${server.baseUrl}/api/course/sync`, { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ reached: true });
    } finally {
      await server.close();
    }
  });

  it("O: disconnecting Whop does not invalidate the Knovera token — the same token still works on Knovera-only routes right after", async () => {
    await saveAuthSession(pool, { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) }, KEY);
    const oauthClient = makeOAuthClient({ revokeRefreshToken: vi.fn(async () => undefined) });
    const server = await startTestApp(oauthClient);
    const token = issueKnoveraToken(SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const disconnectRes = await fetch(`${server.baseUrl}/api/auth/disconnect`, { method: "POST", headers });
      expect(disconnectRes.status).toBe(200);

      const projectsRes = await fetch(`${server.baseUrl}/api/projects`, { headers });
      expect(projectsRes.status).toBe(200);

      const syncRes = await fetch(`${server.baseUrl}/api/course/sync`, { method: "POST", headers });
      expect(syncRes.status).toBe(409);
      expect((await syncRes.json())).toMatchObject({ error: { type: "WHOP_NOT_CONNECTED" } });
    } finally {
      await server.close();
    }
  });

  it("H: a Whop-shaped opaque bearer token cannot act as a Knovera token", async () => {
    const server = await startTestApp(makeOAuthClient());
    try {
      const res = await fetch(`${server.baseUrl}/api/projects`, {
        headers: { Authorization: "Bearer whop_opaque_access_token_abc123" },
      });
      expect(res.status).toBe(401);
      expect((await res.json())).toMatchObject({ error: { type: "knovera_unauthenticated" } });
    } finally {
      await server.close();
    }
  });

  it("rejects every Knovera-gated route with no Authorization header at all", async () => {
    const server = await startTestApp(makeOAuthClient());
    try {
      const [projects, sync, disconnect, lessons] = await Promise.all([
        fetch(`${server.baseUrl}/api/projects`),
        fetch(`${server.baseUrl}/api/course/sync`, { method: "POST" }),
        fetch(`${server.baseUrl}/api/auth/disconnect`, { method: "POST" }),
        fetch(`${server.baseUrl}/api/course/lessons`),
      ]);
      expect(projects.status).toBe(401);
      expect(sync.status).toBe(401);
      expect(disconnect.status).toBe(401);
      expect(lessons.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
