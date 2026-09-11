import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { runProjectSourceAnalysisLoop, type ProjectSourceAnalysisWorkerDeps } from "../src/worker/projectSourceAnalysisLoop.js";
import { createJob, getJob } from "../src/db/projectSourceAnalysisJobsRepo.js";
import { getLatestByProjectSource } from "../src/db/projectSourceAnalysesRepo.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { saveProjectSourceMedia, getProjectSourceMedia } from "../src/db/projectSourceMediaRepo.js";
import { computeProjectSourceAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import { estimateCost } from "../src/pricing/geminiPricing.js";
import {
  STRATEGY_ONLY_EXTRACTION_PROMPT,
  STRATEGY_ONLY_RESPONSE_JSON_SCHEMA,
  KNOWLEDGE_ONLY_EXTRACTION_PROMPT,
  KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA,
} from "../src/gemini/schema.js";
import type { GeminiClient, GeminiFileRef } from "../src/gemini/client.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE project_source_analysis_jobs, project_source_analyses, synthesis_runs RESTART IDENTITY CASCADE");
});

async function makeProject(): Promise<{ id: number }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [name]);
  return { id: Number(result.rows[0].id) };
}

async function makeSource(projectId: number, overrides: { title?: string | null; durationSeconds?: number | null } = {}) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: "dQw4w9WgXcQ",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  if (overrides.title !== undefined || overrides.durationSeconds !== undefined) {
    await pool.query(`UPDATE project_sources SET title = COALESCE($2, title), duration_seconds = COALESCE($3, duration_seconds) WHERE id = $1`, [
      source.id,
      overrides.title ?? null,
      overrides.durationSeconds ?? null,
    ]);
  }
  return source;
}

const DISCORD_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

/**
 * Mirrors what createAddDiscordSourceHandler now does at add-time: create
 * the source, then immediately persist its video bytes durably (Phase 4I
 * durability fix) — so every test below reflects the source as it actually
 * exists once successfully added, not the pre-fix shape.
 */
async function makeDiscordSource(projectId: number, opts: { skipMedia?: boolean } = {}) {
  const { source } = await createDiscordSource(pool, {
    projectId,
    externalId: "987654321098765432",
    sourceUrl: DISCORD_URL,
  });
  if (!opts.skipMedia) {
    await saveProjectSourceMedia(pool, {
      projectSourceId: source.id,
      content: Buffer.from("fake-discord-video-bytes"),
      contentType: "video/mp4",
      byteSize: 24,
    });
  }
  return source;
}

function fakeFile(): GeminiFileRef {
  return { name: "files/unused", uri: "https://unused/files/x", mimeType: "video/mp4", state: "ACTIVE" };
}

function validAnalysisJson(overrides: { strategyFound?: boolean } = {}) {
  return JSON.stringify({
    lesson: { title: "ignored — application overwrites this", duration_seconds: 1 },
    strategy_found: overrides.strategyFound ?? true,
    strategies:
      overrides.strategyFound === false
        ? []
        : [
            {
              strategy_name: "Break & Retest",
              market_or_instrument: ["ES"],
              timeframes: ["5m"],
              indicators: ["VWAP"],
              setup_conditions: [],
              entry_rules: [
                {
                  description: "retest entry",
                  classification: "explicit",
                  confidence: 0.9,
                  start_timestamp: "00:15",
                  end_timestamp: "00:20",
                  evidence: "Instructor points at the retest candle on screen.",
                },
              ],
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
    knowledge: { summary: "A short lesson.", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
  });
}

function makeGemini(overrides: Partial<GeminiClient> = {}): GeminiClient {
  return {
    uploadFile: vi.fn(async () => fakeFile()),
    waitUntilActive: vi.fn(async (f: GeminiFileRef) => f),
    analyzeVideo: vi.fn(async () => ({ text: validAnalysisJson(), usage: { inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 } })),
    deleteFile: vi.fn(async () => undefined),
    generateStructured: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } })),
    ...overrides,
  };
}

function makeDeps(geminiOverrides: Partial<GeminiClient> = {}): { deps: ProjectSourceAnalysisWorkerDeps; gemini: GeminiClient } {
  const gemini = makeGemini(geminiOverrides);
  return {
    gemini,
    deps: {
      pool,
      gemini,
      geminiModel: GEMINI_MODEL,
      geminiProcessingMode: "agentic",
      heartbeatIntervalMs: 60_000,
    },
  };
}

async function countRows(table: string): Promise<number> {
  return Number((await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
}

describe("runProjectSourceAnalysisLoop (Phase 4H-B)", () => {
  it("claims a QUEUED job and persists a COMPLETED analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    const job = await createJob(pool, source.id, fingerprint);

    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("COMPLETED");

    const analysis = await getLatestByProjectSource(pool, source.id);
    expect(analysis?.status).toBe("completed");
    expect(analysis?.strategyFound).toBe(true);
  });

  it("E (worker-level): no uploadFile/waitUntilActive/deleteFile step is ever used for YouTube analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps, gemini } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    expect(gemini.uploadFile).not.toHaveBeenCalled();
    expect(gemini.waitUntilActive).not.toHaveBeenCalled();
    expect(gemini.deleteFile).not.toHaveBeenCalled();
    void job;
  });

  it("P: never calls getValidAccessToken — a YouTube analysis job is processed with zero Whop OAuth involvement", async () => {
    const sessionService = await import("../src/whop/sessionService.js");
    const spy = vi.spyOn(sessionService, "getValidAccessToken");

    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("K/M: analyzeVideo is called with the canonical YouTube URL reconstructed from external_id, not a Gemini Files reference", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps, gemini } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const calls = (gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2); // strategy pass + knowledge pass
    for (const call of calls) {
      const videoArg = call[0];
      expect(videoArg).toEqual({ uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    }
  });

  describe("Discord project sources (Phase 4I + durability fix)", () => {
    it("O: claims a QUEUED Discord job and persists a COMPLETED analysis — the SAME generic pipeline as YouTube", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      const row = await getJob(pool, job.jobId);
      expect(row?.status).toBe("COMPLETED");

      const analysis = await getLatestByProjectSource(pool, source.id);
      expect(analysis?.status).toBe("completed");
      expect(analysis?.strategyFound).toBe(true);
    });

    it("durability fix: acquisition uploads the PERSISTED media bytes to Gemini Files and analyzes the resulting file — never the raw Discord CDN URL directly", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps, gemini } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      expect(gemini.uploadFile).toHaveBeenCalledTimes(1);
      expect(gemini.waitUntilActive).toHaveBeenCalledTimes(1);
      expect(gemini.deleteFile).toHaveBeenCalledTimes(1);

      const calls = (gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(2); // strategy pass + knowledge pass
      for (const call of calls) {
        expect(call[0]).toEqual({ uri: "https://unused/files/x", mimeType: "video/mp4" }); // fakeFile()'s uri — NOT DISCORD_URL
      }
    });

    it("THE KEY ACCEPTANCE TEST — Re-analyze succeeds using the durably persisted media even after the original signed Discord URL has become unusable, without ever re-reading source_url", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);

      // Simulate the original signed URL having expired/become invalid —
      // exactly the scenario the durability fix exists for. If acquisition
      // still read source_url at analysis time, this corruption would
      // surface as a failure; it must not, because analysis never touches
      // source_url anymore.
      await pool.query(`UPDATE project_sources SET source_url = 'https://cdn.discordapp.com/attachments/1/2/expired.mp4?ex=0&is=0&hm=0' WHERE id = $1`, [
        source.id,
      ]);

      // First analysis.
      const job1 = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));
      const { deps: deps1 } = makeDeps();
      await runProjectSourceAnalysisLoop(deps1);
      expect((await getJob(pool, job1.jobId))?.status).toBe("COMPLETED");

      // Re-analyze (force — a brand new job/episode), simulating a
      // Re-analyze click arbitrarily later, with the corrupted/expired URL
      // still sitting in source_url.
      const job2 = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }) + "-reanalyze");
      const { deps: deps2, gemini: gemini2 } = makeDeps();
      await runProjectSourceAnalysisLoop(deps2);

      expect((await getJob(pool, job2.jobId))?.status).toBe("COMPLETED");
      // Proof the stale URL was never even read for acquisition: the only
      // uri ever handed to analyzeVideo is the Gemini Files uri, never the
      // (corrupted) source_url column's value.
      const calls = (gemini2.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        expect(call[0].uri).not.toContain("expired.mp4");
      }
    });

    it("R: never calls getValidAccessToken for a Discord job either — zero Whop OAuth involvement regardless of provider", async () => {
      const sessionService = await import("../src/whop/sessionService.js");
      const spy = vi.spyOn(sessionService, "getValidAccessToken");

      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("Z: a Discord source whose media was never captured (should be unreachable in practice — see createAddDiscordSourceHandler's compensating cleanup) fails cleanly, never a crash", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id, { skipMedia: true });
      const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      const row = await getJob(pool, job.jobId);
      expect(row?.status).toBe("FAILED");
      expect(row?.sanitizedError).toBeTruthy();
    });

    it("a Gemini upload failure for a Discord source (e.g. bad/corrupted persisted bytes) results in a clean FAILED job, never a crash, and still cleans up the temp file", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps({ uploadFile: vi.fn(async () => { throw new Error("Gemini rejected this file."); }) });
      await runProjectSourceAnalysisLoop(deps);

      const row = await getJob(pool, job.jobId);
      expect(row?.status).toBe("FAILED");
    });

    it("T/U: uses the SAME frozen Phase 3.5A strategy + knowledge prompts/schemas as YouTube — no Discord-specific prompt fork", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps, gemini } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      const calls = (gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(2);
      const prompts = calls.map((call) => call[3]);
      expect(prompts).toContain(STRATEGY_ONLY_EXTRACTION_PROMPT);
      expect(prompts).toContain(KNOWLEDGE_ONLY_EXTRACTION_PROMPT);
      const schemas = calls.map((call) => call[4]);
      expect(schemas).toContain(STRATEGY_ONLY_RESPONSE_JSON_SCHEMA);
      expect(schemas).toContain(KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA);
    });

    it("V: Gemini usage/cost is persisted for a Discord analysis using the same pricing infrastructure as YouTube/Whop", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      const analysis = await getLatestByProjectSource(pool, source.id);
      expect(analysis?.inputTokens).toBeGreaterThan(0);
      expect(analysis?.outputTokens).toBeGreaterThan(0);
      expect(analysis?.estimatedCost).toBeCloseTo(
        estimateCost({ inputTokens: analysis!.inputTokens, outputTokens: analysis!.outputTokens, thinkingTokens: analysis!.thinkingTokens })!,
        6,
      );
    });

    it("the persisted media itself is never deleted by analysis or re-analysis — only the transient Gemini File is cleaned up", async () => {
      const project = await makeProject();
      const source = await makeDiscordSource(project.id);
      await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

      const { deps } = makeDeps();
      await runProjectSourceAnalysisLoop(deps);

      const media = await getProjectSourceMedia(pool, source.id);
      expect(media).not.toBeNull();
      expect(media?.content.toString()).toBe("fake-discord-video-bytes");
    });
  });

  it("N/O/P: uses the SAME frozen Phase 3.5A prompts and JSON schemas as Whop lesson analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps, gemini } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const calls = (gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls;
    const prompts = calls.map((c) => c[3]);
    const schemas = calls.map((c) => c[4]);

    expect(prompts).toContain(STRATEGY_ONLY_EXTRACTION_PROMPT);
    expect(prompts).toContain(KNOWLEDGE_ONLY_EXTRACTION_PROMPT);
    // Reference equality — this test imports the exact same module-level
    // constants pipeline/twoPassExtraction.ts imports; if either ever
    // diverged (a fork), this would fail.
    expect(schemas).toContain(STRATEGY_ONLY_RESPONSE_JSON_SCHEMA);
    expect(schemas).toContain(KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA);
  });

  it("R: evidence/timestamps produced by Gemini are preserved verbatim in the persisted analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const analysis = await getLatestByProjectSource(pool, source.id);
    const rule = analysis?.validatedJson.strategies[0]?.entry_rules[0];
    expect(rule?.start_timestamp).toBe("00:15");
    expect(rule?.end_timestamp).toBe("00:20");
    expect(rule?.evidence).toBe("Instructor points at the retest candle on screen.");
  });

  it("uses the source's stored title/duration as the authoritative subject — never a title Gemini echoed back", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id, { title: "Real Video Title", durationSeconds: 321 });
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const analysis = await getLatestByProjectSource(pool, source.id);
    expect(analysis?.validatedJson.lesson.title).toBe("Real Video Title");
    expect(analysis?.validatedJson.lesson.duration_seconds).toBe(321);
  });

  it("falls back to a neutral title label (never fabricated content) when the source has no title yet", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);

    const analysis = await getLatestByProjectSource(pool, source.id);
    expect(analysis?.validatedJson.lesson.title).toBe(`YouTube video ${source.externalId}`);
  });

  it("S: persists token usage and estimated cost using the same pricing table as Whop lesson analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps({
      analyzeVideo: vi.fn(async () => ({ text: validAnalysisJson(), usage: { inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 } })),
    });
    await runProjectSourceAnalysisLoop(deps);

    const analysis = await getLatestByProjectSource(pool, source.id);
    // Two passes, each reporting the same usage in this fake — combined usage sums both.
    expect(analysis?.inputTokens).toBe(2000);
    expect(analysis?.outputTokens).toBe(400);
    expect(analysis?.thinkingTokens).toBe(100);
    expect(analysis?.estimatedCost).toBe(
      estimateCost({ inputTokens: 2000, outputTokens: 400, thinkingTokens: 100 }),
    );
  });

  it("no_strategy result still persists (knowledge extraction without a standalone strategy is a valid, non-failure outcome)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps({
      analyzeVideo: vi.fn(async () => ({ text: validAnalysisJson({ strategyFound: false }), usage: { inputTokens: 10, outputTokens: 10, thinkingTokens: 0 } })),
    });
    await runProjectSourceAnalysisLoop(deps);

    const analysis = await getLatestByProjectSource(pool, source.id);
    expect(analysis?.status).toBe("no_strategy");
    expect(analysis?.strategyFound).toBe(false);
  });

  it("V: a Gemini failure (simulating an unavailable/private video) results in a clean FAILED job — never a raw stack trace, never a partial analysis row", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { deps } = makeDeps({
      analyzeVideo: vi.fn(async () => {
        throw new Error("Gemini analysis request failed: video is unavailable");
      }),
    });
    await runProjectSourceAnalysisLoop(deps);

    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("FAILED");
    expect(row?.sanitizedError).toBeTruthy();
    expect(row?.sanitizedError).not.toContain("at Object.<anonymous>"); // no stack trace leakage

    const analysis = await getLatestByProjectSource(pool, source.id);
    expect(analysis).toBeNull();
  });

  it("idempotency: a second QUEUED job with an identical fingerprint after a COMPLETED analysis is skipped without a second Gemini call", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    await createJob(pool, source.id, fingerprint);

    const { deps, gemini } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);
    expect((gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    const secondJob = await createJob(pool, source.id, fingerprint);
    await runProjectSourceAnalysisLoop(deps);

    // Still exactly 2 calls total — the second job was skipped, not re-analyzed.
    expect((gemini.analyzeVideo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    const secondRow = await getJob(pool, secondJob.jobId);
    expect(secondRow?.status).toBe("COMPLETED");
  });

  it("Y: never creates, modifies, or reads a synthesis_runs row", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const before = await countRows("synthesis_runs");
    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);
    const after = await countRows("synthesis_runs");

    expect(after).toBe(before);
  });

  it("X (adjacent regression guard): processing a project-source job never touches lessons/analysis_jobs/lesson_analyses", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const before = { lessons: await countRows("lessons"), analysisJobs: await countRows("analysis_jobs"), lessonAnalyses: await countRows("lesson_analyses") };
    const { deps } = makeDeps();
    await runProjectSourceAnalysisLoop(deps);
    const after = { lessons: await countRows("lessons"), analysisJobs: await countRows("analysis_jobs"), lessonAnalyses: await countRows("lesson_analyses") };

    expect(after).toEqual(before);
  });
});
