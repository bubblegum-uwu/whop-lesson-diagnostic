import { describe, it, expect, afterEach, afterAll } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { requireKnoveraAuth } from "../src/http/middleware/knoveraAuth.js";
import { createGetProjectSourcesHandler, createAddYouTubeSourceHandler, createAddDiscordSourceHandler } from "../src/http/routes/projectSources.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { deleteAuthSession, saveAuthSession, markAuthRequired, getAuthSessionStatus } from "../src/db/authSessionRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const SECRET = "test-youtube-sources-integration-secret";

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

async function startTestApp(): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  const knoveraAuth = requireKnoveraAuth({ authSecret: SECRET });
  const projectsDeps = { pool };

  app.get("/api/projects/:projectId/sources", knoveraAuth, createGetProjectSourcesHandler(projectsDeps));
  app.post("/api/projects/:projectId/sources/youtube", knoveraAuth, createAddYouTubeSourceHandler(projectsDeps));
  app.post("/api/projects/:projectId/sources/discord", knoveraAuth, createAddDiscordSourceHandler(projectsDeps));

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
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, project_type) VALUES ($1, 'GENERAL_KNOWLEDGE') RETURNING id`,
    [name],
  );
  return { id: Number(result.rows[0].id) };
}

describe("POST /api/projects/:projectId/sources/youtube — auth + Whop-independence (Phase 4H-A)", () => {
  it("K: an unauthenticated request (no bearer token) is rejected with 401 and creates nothing", async () => {
    const server = await startTestApp();
    try {
      const project = await makeProject();
      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      });
      expect(res.status).toBe(401);

      const sourcesRes = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources`, {
        headers: { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}` },
      });
      const body = (await sourcesRes.json()) as { sources: unknown[] };
      expect(body.sources).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("K: an unauthenticated request with a malformed Authorization header is rejected with 401", async () => {
    const server = await startTestApp();
    try {
      const project = await makeProject();
      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "not-a-bearer-token" },
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("L: succeeds with a valid Knovera token even when Whop has never been connected (no auth_sessions row at all)", async () => {
    expect(await getAuthSessionStatus(pool)).toBeNull();

    const server = await startTestApp();
    try {
      const project = await makeProject();
      const headers = { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`, "Content-Type": "application/json" };

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/youtube`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { source: { provider: string }; duplicate: boolean };
      expect(body.source.provider).toBe("YOUTUBE");
      expect(body.duplicate).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("L: succeeds with a valid Knovera token even when Whop is connected but in AUTH_REQUIRED (a stale/broken connection)", async () => {
    await saveAuthSession(
      pool,
      {
        whopUserId: "user_operator",
        accessToken: "irrelevant-access-token",
        refreshToken: "irrelevant-refresh-token",
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
      },
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // 32 bytes, base64 — encryption key, only used to write this row
    );
    await markAuthRequired(pool);

    const server = await startTestApp();
    try {
      const project = await makeProject();
      const headers = { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`, "Content-Type": "application/json" };

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/youtube`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
      });

      expect(res.status).toBe(201);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/projects/:projectId/sources/discord — auth + Whop-independence (Phase 4I)", () => {
  const DISCORD_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

  it("B: an unauthenticated request (no bearer token) is rejected with 401 and creates nothing — same middleware wiring as the YouTube route", async () => {
    const server = await startTestApp();
    try {
      const project = await makeProject();
      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/discord`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: DISCORD_URL }),
      });
      expect(res.status).toBe(401);

      const sourcesRes = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources`, {
        headers: { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}` },
      });
      const body = (await sourcesRes.json()) as { sources: unknown[] };
      expect(body.sources).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("F: succeeds with a valid Knovera token even when Whop has never been connected (no auth_sessions row at all)", async () => {
    expect(await getAuthSessionStatus(pool)).toBeNull();

    const server = await startTestApp();
    try {
      const project = await makeProject();
      const headers = { Authorization: `Bearer ${await issueKnoveraToken(SECRET)}`, "Content-Type": "application/json" };

      const res = await fetch(`${server.baseUrl}/api/projects/${project.id}/sources/discord`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: DISCORD_URL }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { source: { provider: string }; duplicate: boolean };
      expect(body.source.provider).toBe("DISCORD");
      expect(body.duplicate).toBe(false);
    } finally {
      await server.close();
    }
  });
});
