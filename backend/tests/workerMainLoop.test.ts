import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons, getLessonById } from "../src/db/lessonsRepo.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { createJob, getJob } from "../src/db/analysisJobsRepo.js";
import { findLatestByFingerprint } from "../src/db/lessonAnalysesRepo.js";
import { listByAnalysisId } from "../src/db/strategyInstancesRepo.js";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import { buildLessonSourceUrl } from "../src/whop/lessonUrl.js";
import { runWorkerLoop, type WorkerLoopDeps } from "../src/worker/mainLoop.js";
import { WhopApiError } from "../src/whop/client.js";
import { GeminiAnalysisError, type GeminiClient, type GeminiFileRef } from "../src/gemini/client.js";
import type { WhopOAuthClient } from "../src/whop/oauthClient.js";
import type { WhopCourseLessonResponse } from "../src/whop/types.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const KEY = randomBytes(32).toString("base64");
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
  await deleteAuthSession(pool);
});

// auth_sessions is a genuine singleton shared across the whole test database
// (see backend/README.md "single-operator system") — leaving a row behind
// after this file's LAST test would break any other test file that later
// asserts "no session has ever been established" against the same table,
// since vitest's file order here isn't guaranteed to put this file first.
afterEach(async () => {
  await deleteAuthSession(pool);
});

async function makeLesson(durationSeconds: number | null = 600) {
  const courseId = randomId("cors");
  const experienceId = "exp_gdmood6JIzSsE7";
  const course = await upsertCourse(pool, {
    whopCourseId: courseId,
    whopExperienceId: experienceId,
    slug: "scarface-trades-mastermind",
    title: "Scarface Trades Mastermind",
  });
  const lessonId = randomId("lesn");
  await syncLessons(pool, course.id, [
    {
      whopLessonId: lessonId,
      title: "Lesson",
      lessonType: "video",
      visibility: "visible",
      chapterWhopId: null,
      chapterTitle: null,
      chapterOrder: null,
      courseOrder: 1,
      durationSeconds,
      videoAssetStatus: "ready",
      videoAvailable: true,
      sourceUrl: buildLessonSourceUrl("scarface-trades-mastermind", experienceId, courseId, lessonId),
    },
  ]);
  const [lesson] = await listLessons(pool, course.id);
  return lesson;
}

async function activeSession() {
  await saveAuthSession(
    pool,
    { whopUserId: "user_operator", accessToken: "a", refreshToken: "r", accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
    KEY,
  );
}

function makeOAuthClient(): WhopOAuthClient {
  return { refreshAccessToken: vi.fn(), revokeRefreshToken: vi.fn(), verifyAccessToken: vi.fn() };
}

function makeFile(): GeminiFileRef {
  return { name: "files/x", uri: "https://x/files/x", mimeType: "video/mp4", state: "ACTIVE" };
}

const validJson = JSON.stringify({
  lesson: { title: "ignored", duration_seconds: 1 },
  strategy_found: true,
  strategies: [
    {
      strategy_name: "Break & Retest",
      market_or_instrument: ["ES"],
      timeframes: ["5m"],
      indicators: ["VWAP"],
      setup_conditions: [],
      entry_rules: [{ description: "retest entry", classification: "explicit", confidence: 0.9, start_timestamp: "00:10", end_timestamp: null, evidence: "e" }],
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

function makeGemini(overrides: Partial<GeminiClient> = {}): GeminiClient {
  return {
    uploadFile: vi.fn(async () => makeFile()),
    waitUntilActive: vi.fn(async (f: GeminiFileRef) => f),
    analyzeVideo: vi.fn(async () => ({ text: validJson, usage: { inputTokens: 1000, outputTokens: 100, thinkingTokens: 10 } })),
    deleteFile: vi.fn(async () => undefined),
    generateStructured: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } })),
    ...overrides,
  };
}

function makeLessonResponse(overrides: Partial<WhopCourseLessonResponse> = {}): WhopCourseLessonResponse {
  return {
    id: "lesn_x",
    title: "Lesson",
    lesson_type: "video",
    visibility: "visible",
    embed_type: null,
    embed_id: null,
    video_asset: {
      id: "mux_x",
      asset_id: "asset_x",
      playback_id: null,
      signed_playback_id: "pb_x",
      status: "ready",
      audio_only: false,
      duration_seconds: 700,
      signed_video_playback_token: "tok",
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<WorkerLoopDeps["pipelineDeps"]> = {}, geminiOverrides: Partial<GeminiClient> = {}): WorkerLoopDeps {
  return {
    pool,
    oauthClient: makeOAuthClient(),
    refreshTokenEncryptionKey: KEY,
    pipelineDeps: {
      fetchWhopLesson: vi.fn(async () => makeLessonResponse()),
      gemini: makeGemini(geminiOverrides),
      geminiModel: GEMINI_MODEL,
      geminiProcessingMode: "agentic",
      remux: vi.fn(async () => undefined),
      ffmpegPath: "ffmpeg",
      ...overrides,
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("runWorkerLoop", () => {
  it("processes a QUEUED job end-to-end: COMPLETED, strategy persisted, usage persisted, duration backfilled", async () => {
    await activeSession();
    const lesson = await makeLesson(null);
    const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: GEMINI_MODEL });
    const job = await createJob(pool, lesson.id, fingerprint);

    await runWorkerLoop(makeDeps());

    const finalJob = await getJob(pool, job.jobId);
    expect(finalJob?.status).toBe("COMPLETED");
    expect(finalJob?.leaseOwner).toBeNull();

    const analysis = await findLatestByFingerprint(pool, fingerprint);
    expect(analysis?.strategyFound).toBe(true);
    // Two independent Gemini calls now happen per analysis (strategy pass +
    // knowledge pass — see pipeline/analyzeLesson.ts's two-pass
    // architecture); the mock returns the same usage for both calls, so
    // the persisted total is double the per-call figure.
    expect(analysis?.inputTokens).toBe(2000);
    expect(analysis?.estimatedCost).toBeGreaterThan(0);

    const strategies = await listByAnalysisId(pool, analysis!.analysisId);
    expect(strategies).toHaveLength(1);
    expect(strategies[0].strategy_name).toBe("Break & Retest");

    // Whop reported duration_seconds:700 even though the lesson row had none at sync time.
    const updatedLesson = await getLessonById(pool, lesson.id);
    expect(updatedLesson?.durationSeconds).toBe(700);
  });

  it("processes multiple queued jobs in one execution before exiting (no busy-loop, no premature exit)", async () => {
    await activeSession();
    const lessonA = await makeLesson();
    const lessonB = await makeLesson();
    await createJob(pool, lessonA.id, "fp-a");
    await createJob(pool, lessonB.id, "fp-b");

    const gemini = makeGemini();
    await runWorkerLoop(makeDeps({}, gemini));

    // 2 jobs x 2 Gemini calls each (strategy pass + knowledge pass).
    expect(gemini.analyzeVideo).toHaveBeenCalledTimes(4);
    const jobA = (await getJob(pool, (await findLatestByFingerprint(pool, "fp-a"))!.jobId))!;
    const jobB = (await getJob(pool, (await findLatestByFingerprint(pool, "fp-b"))!.jobId))!;
    expect(jobA.status).toBe("COMPLETED");
    expect(jobB.status).toBe("COMPLETED");
  });

  it("skips Gemini work entirely when an identical successful analysis already exists (idempotency)", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: GEMINI_MODEL });

    const firstJob = await createJob(pool, lesson.id, fingerprint);
    const gemini = makeGemini();
    await runWorkerLoop(makeDeps({}, gemini));
    // 2 Gemini calls (strategy pass + knowledge pass) for this one job.
    expect(gemini.analyzeVideo).toHaveBeenCalledTimes(2);
    expect((await getJob(pool, firstJob.jobId))?.status).toBe("COMPLETED");

    // A second job for the SAME fingerprint (simulating a duplicate enqueue).
    const secondJob = await createJob(pool, lesson.id, fingerprint);
    await runWorkerLoop(makeDeps({}, gemini));
    expect(gemini.analyzeVideo).toHaveBeenCalledTimes(2); // still 2 — no second Gemini work at all
    expect((await getJob(pool, secondJob.jobId))?.status).toBe("COMPLETED");
  });

  it("classifies a transient Whop error as a bounded retry, not a permanent failure", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-transient");
    const fetchWhopLesson = vi.fn(async () => {
      throw new WhopApiError("rate limited", 429, "rate_limit");
    });

    await runWorkerLoop(makeDeps({ fetchWhopLesson }));

    const finalJob = await getJob(pool, job.jobId);
    expect(finalJob?.status).toBe("QUEUED");
    expect(finalJob?.errorType).toBe("transient");
    expect(finalJob?.nextRetryAt).not.toBeNull();
    expect(finalJob!.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("classifies a permanent Gemini failure as FAILED, terminal", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-permanent");
    const gemini = makeGemini({
      analyzeVideo: vi.fn(async () => {
        throw new GeminiAnalysisError("Gemini analysis request failed: response failed schema validation");
      }),
    });

    await runWorkerLoop(makeDeps({}, gemini));

    const finalJob = await getJob(pool, job.jobId);
    expect(finalJob?.status).toBe("FAILED");
    expect(finalJob?.errorType).toBe("permanent");
    expect(finalJob?.sanitizedError).toContain("schema validation");
  });

  it("parks the job as AUTH_REQUIRED when no Whop session exists yet, without destroying the queue", async () => {
    // Deliberately no activeSession() call.
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-auth");

    await runWorkerLoop(makeDeps());

    const finalJob = await getJob(pool, job.jobId);
    expect(finalJob?.status).toBe("AUTH_REQUIRED");
  });

  it("never fabricates token usage/cost — no_strategy analyses still record whatever Gemini actually reported", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const fingerprint = "fp-no-strategy";
    const job = await createJob(pool, lesson.id, fingerprint);
    const noStrategyJson = JSON.stringify({ lesson: { title: "t", duration_seconds: 1 }, strategy_found: false, strategies: [], knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] } });
    const gemini = makeGemini({ analyzeVideo: vi.fn(async () => ({ text: noStrategyJson, usage: { inputTokens: 500, outputTokens: 20, thinkingTokens: 0 } })) });

    await runWorkerLoop(makeDeps({}, gemini));

    expect((await getJob(pool, job.jobId))?.status).toBe("NO_STRATEGY");
    const analysis = await findLatestByFingerprint(pool, fingerprint);
    expect(analysis?.status).toBe("no_strategy");
    expect(analysis?.strategyFound).toBe(false);
    // Summed across both Gemini calls (strategy pass + knowledge pass).
    expect(analysis?.inputTokens).toBe(1000);
  });

  // Phase 3.5: a lesson can have strategy_found=false while still carrying
  // real, persisted supporting knowledge (risk management, sizing, ...) —
  // this proves that content survives the full worker persistence path
  // (createLessonAnalysis's validated_json, not just the in-memory Gemini
  // result), and that createStrategyInstances is still correctly skipped
  // (zero strategy_instances rows) even though the analysis itself is rich.
  it("persists real supporting knowledge for a no-strategy lesson — strategyFound=false never means nothing useful was extracted", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const fingerprint = "fp-no-strategy-rich";
    const job = await createJob(pool, lesson.id, fingerprint);
    const richNoStrategyJson = JSON.stringify({
      lesson: { title: "t", duration_seconds: 1 },
      strategy_found: false,
      strategies: [],
      knowledge: {
        summary: "Covers position sizing and risk management for scaling into trades.",
        knowledgeItems: [
          {
            category: "risk_management",
            statement: "Never risk more than 1% of account equity on a single trade.",
            ruleType: "HARD_RULE",
            classification: "explicit",
            confidence: 0.95,
            conditions: null,
            exceptions: [],
            scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
            numericalValues: [
              { metric: "max risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "1%", context: "max risk per trade" },
            ],
            start_timestamp: "02:15",
            end_timestamp: null,
            evidence: "Spoken instruction at 02:15.",
          },
        ],
        examples: [],
        conflictsAndAmbiguities: [],
      },
    });
    const gemini = makeGemini({ analyzeVideo: vi.fn(async () => ({ text: richNoStrategyJson, usage: { inputTokens: 500, outputTokens: 120, thinkingTokens: 10 } })) });

    await runWorkerLoop(makeDeps({}, gemini));

    expect((await getJob(pool, job.jobId))?.status).toBe("NO_STRATEGY");
    const analysis = await findLatestByFingerprint(pool, fingerprint);
    expect(analysis?.strategyFound).toBe(false);
    expect(analysis?.validatedJson.knowledge.knowledgeItems).toHaveLength(1);
    expect(analysis?.validatedJson.knowledge.knowledgeItems[0].category).toBe("risk_management");
    expect(analysis?.validatedJson.knowledge.knowledgeItems[0].ruleType).toBe("HARD_RULE");
    // strategy_instances is still correctly skipped — this is knowledge, not a standalone setup.
    const instances = await listByAnalysisId(pool, analysis!.analysisId);
    expect(instances).toHaveLength(0);
  });

  it("a second concurrent execution exits immediately without processing anything (advisory lock is authoritative)", async () => {
    await activeSession();
    const lessonA = await makeLesson();
    const lessonB = await makeLesson();
    await createJob(pool, lessonA.id, "fp-lock-a");
    await createJob(pool, lessonB.id, "fp-lock-b");

    const gemini = makeGemini();
    const depsA = makeDeps({}, gemini);
    const depsB = makeDeps({}, gemini);

    await Promise.all([runWorkerLoop(depsA), runWorkerLoop(depsB)]);

    // Both jobs were processed exactly once in total (2 jobs x 2 Gemini
    // calls each — strategy pass + knowledge pass), by whichever execution won the lock.
    expect(gemini.analyzeVideo).toHaveBeenCalledTimes(4);
    const jobA = await findLatestByFingerprint(pool, "fp-lock-a");
    const jobB = await findLatestByFingerprint(pool, "fp-lock-b");
    expect(jobA).not.toBeNull();
    expect(jobB).not.toBeNull();
  });
});
