import { describe, it, expect, afterAll } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { requireKnoveraAuth } from "../src/http/middleware/knoveraAuth.js";
import { createCreateProjectHandler, createListProjectsHandler, createGetProjectHandler } from "../src/http/routes/projects.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

const SECRET = "test-knovera-project-creation-secret";

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestApp(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const knoveraAuth = requireKnoveraAuth({ authSecret: SECRET });
  const projectsDeps = { pool };

  app.post("/api/projects", knoveraAuth, createCreateProjectHandler(projectsDeps));
  app.get("/api/projects", knoveraAuth, createListProjectsHandler(projectsDeps));
  app.get("/api/projects/:projectId", knoveraAuth, createGetProjectHandler(projectsDeps));

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

describe("POST /api/projects — Phase 4G, end to end through real auth middleware", () => {
  it("rejects an unauthenticated request with 401 and creates no project", async () => {
    const server = await startTestApp();
    try {
      const before = await fetch(`${server.baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}` },
      });
      const beforeCount = ((await before.json()) as { projects: unknown[] }).projects.length;

      const res = await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: randomId("should-not-be-created"), projectType: "TRADING_STRATEGIES" }),
      });
      expect(res.status).toBe(401);

      const after = await fetch(`${server.baseUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}` },
      });
      const afterCount = ((await after.json()) as { projects: unknown[] }).projects.length;
      expect(afterCount).toBe(beforeCount);
    } finally {
      await server.close();
    }
  });

  it("rejects a request with an invalid/garbage bearer token", async () => {
    const server = await startTestApp();
    try {
      const res = await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", projectType: "TRADING_STRATEGIES" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("succeeds end to end with a valid Knovera session token: create, then list, then fetch by id", async () => {
    const server = await startTestApp();
    try {
      const headers = {
        Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`,
        "Content-Type": "application/json",
      };
      const name = randomId("e2e-project");

      const createRes = await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, projectType: "TRADING_STRATEGIES" }),
      });
      expect(createRes.status).toBe(201);
      const { project } = (await createRes.json()) as { project: { id: number; name: string; courseCount: number } };
      expect(project.name).toBe(name);
      expect(project.courseCount).toBe(0);

      const listRes = await fetch(`${server.baseUrl}/api/projects`, { headers });
      const { projects } = (await listRes.json()) as { projects: Array<{ id: number }> };
      expect(projects.some((p) => p.id === project.id)).toBe(true);

      const getRes = await fetch(`${server.baseUrl}/api/projects/${project.id}`, { headers });
      expect(getRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("a newly created project's GET /api/projects/:id/sources-equivalent stats show zero courses immediately (isolation from MasterMind)", async () => {
    const server = await startTestApp();
    try {
      const headers = {
        Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`,
        "Content-Type": "application/json",
      };
      const createRes = await fetch(`${server.baseUrl}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: randomId("isolated-e2e"), projectType: "GENERAL_KNOWLEDGE" }),
      });
      const { project } = (await createRes.json()) as { project: { id: number; courseCount: number; lessonCount: number } };
      expect(project.courseCount).toBe(0);
      expect(project.lessonCount).toBe(0);
    } finally {
      await server.close();
    }
  });
});
