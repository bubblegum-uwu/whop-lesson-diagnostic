import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { requireKnoveraAuth } from "../src/http/middleware/knoveraAuth.js";
import {
  createAnalyzeProjectSourceHandler,
  createGetProjectSourceAnalysisHandler,
  createRetryProjectSourceAnalysisHandler,
} from "../src/http/routes/projectSourceAnalysis.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { deleteAuthSession, saveAuthSession, markAuthRequired } from "../src/db/authSessionRepo.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const SECRET = "test-project-source-analysis-integration-secret";
const GEMINI_MODEL = "gemini-3.8-flash";

afterEach(async () => {
  await deleteAuthSession(pool);
});
afterAll(async () => {
  await pool.end();
});

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

async function startTestApp(jobTrigger: JobTrigger = makeJobTrigger()): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const knoveraAuth = requireKnoveraAuth({ authSecret: SECRET });
  const deps = { pool, jobTrigger, geminiModel: GEMINI_MODEL };

  app.post("/api/projects/:projectId/sources/:sourceId/analyze", knoveraAuth, createAnalyzeProjectSourceHandler(deps));
  app.get("/api/projects/:projectId/sources/:sourceId/analysis", knoveraAuth, createGetProjectSourceAnalysisHandler(deps));
  app.post("/api/projects/:projectId/sources/:sourceId/retry", knoveraAuth, createRetryProjectSourceAnalysisHandler(deps));

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

async function makeProject(): Promise<{ id: number }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [name]);
  return { id: Number(result.rows[0].id) };
}

async function makeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  return source;
}

describe("Project-source analysis routes — auth + Whop-independence (Phase 4H-B)", () => {
  it("E: an unauthenticated analyze request is rejected with 401 and creates no job", async () => {
    const server = await startTestApp();
    try {
      const project = await makeProject();
      const source = await makeSource(project.id);

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/${source.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);

      const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
      expect(Number(countResult.rows[0].count)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("E: an unauthenticated GET analysis request is rejected with 401", async () => {
    const server = await startTestApp();
    try {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/${source.id}/analysis`);
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("F: analyze succeeds with a valid Knovera token even when Whop has never been connected", async () => {
    expect(await pool.query(`SELECT 1 FROM auth_sessions`).then((r) => r.rowCount)).toBe(0);

    const server = await startTestApp();
    try {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const headers = { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`, "Content-Type": "application/json" };

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/${source.id}/analyze`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(202);
      const body = (await res.json()) as { job: { status: string } };
      expect(body.job.status).toBe("QUEUED");
    } finally {
      await server.close();
    }
  });

  it("F: analyze succeeds even when Whop is connected but in AUTH_REQUIRED (a stale/broken connection)", async () => {
    await saveAuthSession(
      pool,
      { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    await markAuthRequired(pool);

    const server = await startTestApp();
    try {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const headers = { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`, "Content-Type": "application/json" };

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/${source.id}/analyze`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(202);
    } finally {
      await server.close();
    }
  });
});
