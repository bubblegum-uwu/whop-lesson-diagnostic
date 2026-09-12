import { describe, it, expect, vi, afterAll } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import express from "express";
import { requireKnoveraAuth } from "../src/http/middleware/knoveraAuth.js";
import { createAddDiscordSourceHandler } from "../src/http/routes/projectSources.js";
import {
  createAnalyzeProjectSourceHandler,
  createGetProjectSourceAnalysisHandler,
  createRetryProjectSourceAnalysisHandler,
} from "../src/http/routes/projectSourceAnalysis.js";
import { issueKnoveraToken } from "../src/lib/knoveraToken.js";
import { runProjectSourceAnalysisLoop } from "../src/worker/projectSourceAnalysisLoop.js";
import { getProjectSourceById } from "../src/db/projectSourcesRepo.js";
import { getContentAssetMedia } from "../src/db/contentAssetsRepo.js";
import type { GeminiClient, GeminiFileRef } from "../src/gemini/client.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";

const pool = createTestPool();
const SECRET = "test-discord-durability-e2e-secret";
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

/**
 * The KEY acceptance test the Phase 4I durability-fix review asked for,
 * run for real rather than mocked at the business-logic layer:
 *
 *   POST a Discord source (real HTTP, real Express route, real Postgres)
 *     -> real acquisition (a real HTTP download over a real local socket,
 *        from a disposable local fixture server standing in for Discord's
 *        CDN — no live Discord account/bot exists to produce a real signed
 *        URL, so this is the "equivalent controlled fixture" the review
 *        explicitly permits)
 *     -> real persistence into project_source_media
 *     -> real QUEUED analysis job
 *     -> the REAL worker loop (runProjectSourceAnalysisLoop) claims and
 *        completes it, uploading the PERSISTED bytes to a mocked Gemini
 *        client (never a live Gemini call, per policy)
 *     -> real GET /analysis ("View") returns the completed result
 *     -> the fixture server is then shut down entirely, so the original
 *        URL becomes genuinely unreachable
 *     -> Re-analyze (force) is requested and the REAL worker loop
 *        completes it again — using ONLY the already-persisted media,
 *        never re-contacting the (now-dead) original source.
 *
 * Discord URL FORMAT/HOST validation (parseDiscordVideoUrl) is exercised
 * completely unweakened throughout — the pasted URL must still look like a
 * genuine cdn.discordapp.com attachment URL. Only the actual byte-fetch
 * destination is redirected to the local fixture, via the same
 * downloadDiscordAttachment injection seam createAddDiscordSourceHandler
 * already exposes for exactly this purpose.
 */
describe("Discord durability fix — real end-to-end acquisition + re-analysis (Phase 4I)", () => {
  it("Add source -> real download+persist -> Analyze -> View -> fixture server shut down -> Re-analyze still succeeds from persisted media alone", async () => {
    const videoBytes = Buffer.from("this-is-a-real-fixture-video-payload");

    // 1) A disposable local HTTP server standing in for Discord's CDN —
    // real TCP, real HTTP response, real bytes over the wire.
    let requestCount = 0;
    const fixtureServer: Server = createServer((req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(videoBytes.length) });
      res.end(videoBytes);
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, resolve));
    const fixtureAddress = fixtureServer.address();
    const fixturePort = typeof fixtureAddress === "object" && fixtureAddress ? fixtureAddress.port : 0;

    // The pasted URL still has to be a genuine-looking Discord CDN URL —
    // parseDiscordVideoUrl runs for real against this exact string inside
    // the real route handler below. The attachment id is freshly random
    // per run (digits only, per lib/discordUrl.ts's SNOWFLAKE_PATTERN) —
    // this test uses the REAL, fixed "knovera-operator" identity
    // (issueKnoveraToken below), so a hardcoded id would collide with the
    // shared content_assets row a previous run of this same test already
    // created for that identity, making the download-call assertion below
    // flaky across repeated runs rather than isolated per invocation.
    const pastedDiscordUrl = `https://cdn.discordapp.com/attachments/123456789012345678/${randomSnowflake()}/clip.mp4?ex=1&is=2&hm=3`;

    // The one injected seam: where bytes are actually fetched FROM. A real
    // HTTP GET, just against the local fixture instead of Discord's real
    // servers.
    const realDownloadAgainstFixture = vi.fn(async (_sourceUrl: string) => {
      const res = await fetch(`http://127.0.0.1:${fixturePort}/attachment`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { content: buf, contentType: res.headers.get("content-type") ?? "video/mp4", byteSize: buf.byteLength };
    });

    // 2) A real Express app wiring the REAL route handlers.
    const app = express();
    app.use(express.json());
    const knoveraAuth = requireKnoveraAuth({ authSecret: SECRET });
    const jobTrigger = { triggerRun: vi.fn(async () => undefined) };
    const analysisDeps = { pool, jobTrigger, geminiModel: GEMINI_MODEL };

    app.post("/api/projects/:projectId/sources/discord", knoveraAuth, createAddDiscordSourceHandler({ pool, downloadDiscordAttachment: realDownloadAgainstFixture }));
    app.post("/api/projects/:projectId/sources/:sourceId/analyze", knoveraAuth, createAnalyzeProjectSourceHandler(analysisDeps));
    app.get("/api/projects/:projectId/sources/:sourceId/analysis", knoveraAuth, createGetProjectSourceAnalysisHandler(analysisDeps));
    app.post("/api/projects/:projectId/sources/:sourceId/retry", knoveraAuth, createRetryProjectSourceAnalysisHandler(analysisDeps));

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const token = await issueKnoveraToken(SECRET);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    try {
      const projectResult = await pool.query<{ id: string }>(
        `INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`,
        [randomId("proj")],
      );
      const projectId = Number(projectResult.rows[0].id);

      // 3) POST the Discord source — real HTTP round trip, real route
      // logic, real download from the real fixture server, real Postgres
      // persistence of the resulting bytes.
      const addRes = await fetch(`${baseUrl}/api/projects/${projectId}/sources/discord`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url: pastedDiscordUrl }),
      });
      expect(addRes.status).toBe(201);
      const addBody = (await addRes.json()) as { source: { id: number; provider: string } };
      expect(addBody.source.provider).toBe("DISCORD");
      const sourceId = addBody.source.id;

      expect(realDownloadAgainstFixture).toHaveBeenCalledTimes(1);
      expect(requestCount).toBe(1);

      const capturedSource = await getProjectSourceById(pool, sourceId);
      const persisted = await getContentAssetMedia(pool, capturedSource!.contentAssetId!);
      expect(persisted?.content.equals(videoBytes)).toBe(true);

      // 4) Analyze.
      const analyzeRes = await fetch(`${baseUrl}/api/projects/${projectId}/sources/${sourceId}/analyze`, { method: "POST", headers, body: "{}" });
      expect(analyzeRes.status).toBe(202);

      // 5) The REAL worker loop, claiming and completing the real job —
      // Gemini itself is mocked (never a live call), but every other step
      // (claim, lease, temp file, "upload", two-pass calls, persistence)
      // is the real production code path.
      const gemini = makeFakeGemini();
      await runProjectSourceAnalysisLoop({ pool, gemini, geminiModel: GEMINI_MODEL, geminiProcessingMode: "agentic", heartbeatIntervalMs: 60_000 });

      // Proves acquisition actually happened (real bytes went through
      // uploadFile) — the exact content written to the temp file is
      // already proven equal to videoBytes above via the persisted
      // project_source_media row, which is what uploadFile is given.
      expect(gemini.uploadFile).toHaveBeenCalledTimes(1);

      // 6) View — GET /analysis.
      const viewRes1 = await fetch(`${baseUrl}/api/projects/${projectId}/sources/${sourceId}/analysis`, { headers });
      const viewBody1 = (await viewRes1.json()) as { job: { status: string }; analysis: { strategyFound: boolean } | null };
      expect(viewBody1.job.status).toBe("COMPLETED");
      expect(viewBody1.analysis?.strategyFound).toBe(true);

      // 7) Shut the fixture server down entirely — the "original signed
      // URL" is now genuinely unreachable, exactly simulating an expired
      // Discord signature. Re-analyze must not need it.
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
      const requestCountBeforeReanalyze = requestCount;

      // 8) Re-analyze (force) — real HTTP call again.
      const reanalyzeRes = await fetch(`${baseUrl}/api/projects/${projectId}/sources/${sourceId}/analyze`, {
        method: "POST",
        headers,
        body: JSON.stringify({ force: true }),
      });
      expect(reanalyzeRes.status).toBe(202);

      // 9) The real worker loop again.
      const gemini2 = makeFakeGemini();
      await runProjectSourceAnalysisLoop({ pool, gemini: gemini2, geminiModel: GEMINI_MODEL, geminiProcessingMode: "agentic", heartbeatIntervalMs: 60_000 });

      // The fixture server never received another request — acquisition
      // for the re-analysis never touched the (now-dead) original source.
      expect(requestCount).toBe(requestCountBeforeReanalyze);
      expect(realDownloadAgainstFixture).toHaveBeenCalledTimes(1); // still just the one, original call

      // 10) View again — the re-analysis completed successfully.
      const viewRes2 = await fetch(`${baseUrl}/api/projects/${projectId}/sources/${sourceId}/analysis`, { headers });
      const viewBody2 = (await viewRes2.json()) as { job: { status: string }; analysis: { strategyFound: boolean } | null };
      expect(viewBody2.job.status).toBe("COMPLETED");
      expect(viewBody2.analysis?.strategyFound).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fixtureServer.close();
    }
  });
});

function makeFakeGemini(): GeminiClient {
  const fakeFile: GeminiFileRef = { name: "files/e2e-fake", uri: "https://unused/files/e2e", mimeType: "video/mp4", state: "ACTIVE" };
  const analysisJson = JSON.stringify({
    lesson: { title: "ignored", duration_seconds: 1 },
    strategy_found: true,
    strategies: [
      {
        strategy_name: "Break & Retest",
        market_or_instrument: [],
        timeframes: [],
        indicators: [],
        setup_conditions: [],
        entry_rules: [{ description: "retest entry", classification: "explicit", confidence: 0.9, start_timestamp: "00:05", end_timestamp: null, evidence: "shown" }],
        confirmation_rules: [],
        stop_loss_rules: [],
        profit_target_rules: [],
        trade_management_rules: [],
        invalidation_rules: [],
        no_trade_conditions: [],
        market_context_rules: [],
        visual_discretionary_rules: [],
        examples_shown: [],
        ambiguities: [],
      },
    ],
    knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
  });
  return {
    uploadFile: vi.fn(async () => fakeFile),
    waitUntilActive: vi.fn(async (f: GeminiFileRef) => f),
    analyzeVideo: vi.fn(async () => ({ text: analysisJson, usage: { inputTokens: 500, outputTokens: 100, thinkingTokens: 20 } })),
    deleteFile: vi.fn(async () => undefined),
    generateStructured: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } })),
  };
}
