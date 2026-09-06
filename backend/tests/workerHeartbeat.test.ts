import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { saveAuthSession, deleteAuthSession } from "../src/db/authSessionRepo.js";
import { createJob, getJob } from "../src/db/analysisJobsRepo.js";
import { findLatestByFingerprint } from "../src/db/lessonAnalysesRepo.js";
import { buildLessonSourceUrl } from "../src/whop/lessonUrl.js";
import { runWorkerLoop, type WorkerLoopDeps } from "../src/worker/mainLoop.js";
import { GeminiAnalysisError, type GeminiClient, type GeminiFileRef } from "../src/gemini/client.js";
import type { WhopOAuthClient } from "../src/whop/oauthClient.js";
import type { WhopCourseLessonResponse } from "../src/whop/types.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

/**
 * These tests exercise the independent heartbeat timer (backend/src/worker/heartbeat.ts)
 * wired into the worker's lease-renewal loop — specifically that it keeps the
 * lease/heartbeat alive during a single long-awaited Gemini call (which produces
 * no progress callback of its own), and that it is always torn down (never
 * leaked) regardless of how a job finishes. See workerMainLoop.test.ts for the
 * broader end-to-end pipeline behavior these tests build on.
 */

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

afterEach(async () => {
  await deleteAuthSession(pool);
  vi.restoreAllMocks();
});

async function makeLesson() {
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
      durationSeconds: 600,
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
});

function makeGemini(overrides: Partial<GeminiClient> = {}): GeminiClient {
  return {
    uploadFile: vi.fn(async () => makeFile()),
    waitUntilActive: vi.fn(async (f: GeminiFileRef) => f),
    analyzeVideo: vi.fn(async () => ({ text: validJson, usage: { inputTokens: 1000, outputTokens: 100, thinkingTokens: 10 } })),
    deleteFile: vi.fn(async () => undefined),
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

function makeDeps(geminiOverrides: Partial<GeminiClient> = {}, heartbeatIntervalMs = 20): WorkerLoopDeps {
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
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    heartbeatIntervalMs,
  };
}

/** A promise plus externally-callable resolve/reject — stands in for a single long-awaited Gemini call. */
function makeGate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls until the job reaches (or passes) the given status, instead of a
 * fixed sleep — this environment's real wall-clock/DB round-trip time is
 * inconsistent enough that a fixed short sleep is flaky. Fails loudly if
 * the status is never reached within `timeoutMs`.
 */
async function waitForJobStatus(jobId: string, status: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(pool, jobId);
    if (job?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for job ${jobId} to reach status ${status} (last seen: ${job?.status})`);
    }
    await sleep(10);
  }
}

/** Cast away pg's heavily-overloaded `query` signature so vi.spyOn/mock typing stays simple in these tests. */
function spyOnQuery() {
  return vi.spyOn(pool as unknown as { query: (...args: unknown[]) => unknown }, "query");
}

/** renewLease's UPDATE is the only query that sets `current_stage = COALESCE(...)` — a stable fingerprint for counting heartbeat/lease-renewal attempts regardless of whether they came from the periodic timer or a pipeline stage callback. */
function renewCallCount(spy: ReturnType<typeof spyOnQuery>): number {
  return spy.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("current_stage = COALESCE")).length;
}

describe("worker heartbeat / lease renewal", () => {
  it("keeps renewing the lease on its own cadence while a single long Gemini call is still awaiting", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-heartbeat-continues");
    const gate = makeGate<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>();
    const deps = makeDeps({ analyzeVideo: vi.fn(() => gate.promise) }, 25);

    const querySpy = spyOnQuery();
    const runPromise = runWorkerLoop(deps);

    // `finally` guarantees the gate always resolves and runPromise always
    // settles even if an assertion below throws — otherwise a failed
    // assertion here would leave this execution stuck forever inside
    // analyzeVideo(), permanently holding the advisory lock and silently
    // breaking every test that runs after this one in the same file.
    try {
      await waitForJobStatus(job.jobId, "ANALYZING");
      // Several more heartbeat ticks' worth of time while still stuck inside
      // the single awaited analyzeVideo() call, which never fires a
      // stage/progress callback of its own.
      await sleep(200);
      const midFlight = await getJob(pool, job.jobId);
      expect(midFlight?.status).toBe("ANALYZING");
      expect(renewCallCount(querySpy)).toBeGreaterThanOrEqual(3);
    } finally {
      // Awaited here too (not just resolved) so this execution has fully
      // finished — including releasing the advisory lock — before the test
      // exits on either a pass or a failed assertion; otherwise a failed
      // assertion above would leave runPromise an orphaned background
      // promise that keeps writing to the DB after later tests (and
      // eventually this file's afterAll -> pool.end()) have already run.
      gate.resolve({ text: validJson, usage: { inputTokens: 10, outputTokens: 1, thinkingTokens: 0 } });
      await runPromise;
    }
    expect((await getJob(pool, job.jobId))?.status).toBe("COMPLETED");
  });

  it("extends lease_expires_at forward in time while Gemini analysis is still in flight", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-lease-extends");
    const gate = makeGate<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>();
    const deps = makeDeps({ analyzeVideo: vi.fn(() => gate.promise) }, 25);

    const runPromise = runWorkerLoop(deps);
    try {
      await waitForJobStatus(job.jobId, "ANALYZING");
      const early = await getJob(pool, job.jobId);
      expect(early?.leaseExpiresAt).not.toBeNull();

      await sleep(150); // several more heartbeat ticks, still blocked on Gemini
      const later = await getJob(pool, job.jobId);
      expect(later?.status).toBe("ANALYZING");
      expect(later!.leaseExpiresAt!.getTime()).toBeGreaterThan(early!.leaseExpiresAt!.getTime());
    } finally {
      gate.resolve({ text: validJson, usage: { inputTokens: 10, outputTokens: 1, thinkingTokens: 0 } });
      await runPromise;
    }
  });

  it("stops the heartbeat timer once the job completes successfully — no further renewals fire", async () => {
    await activeSession();
    const lesson = await makeLesson();
    await createJob(pool, lesson.id, "fp-stop-success");
    const deps = makeDeps({}, 20);

    const querySpy = spyOnQuery();
    await runWorkerLoop(deps);
    const countRightAfter = renewCallCount(querySpy);

    await sleep(150); // several intervals' worth of time after the run loop already returned
    expect(renewCallCount(querySpy)).toBe(countRightAfter);
  });

  it("stops the heartbeat timer once the job fails permanently — no further renewals fire", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-stop-failure");
    const deps = makeDeps({
      analyzeVideo: vi.fn(async () => {
        throw new GeminiAnalysisError("Gemini analysis request failed: response failed schema validation");
      }),
    }, 20);

    const querySpy = spyOnQuery();
    await runWorkerLoop(deps);
    expect((await getJob(pool, job.jobId))?.status).toBe("FAILED");
    const countRightAfter = renewCallCount(querySpy);

    await sleep(150);
    expect(renewCallCount(querySpy)).toBe(countRightAfter);
  });

  it("stops the heartbeat timer as soon as lease ownership is lost, and never renews again", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-lease-lost");
    const gate = makeGate<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>();
    const deps = makeDeps({ analyzeVideo: vi.fn(() => gate.promise) }, 25);

    const runPromise = runWorkerLoop(deps);
    try {
      await waitForJobStatus(job.jobId, "ANALYZING");

      // Simulate another worker execution reclaiming this job's lease (e.g.
      // this execution's lease expired and the Scheduler safety net
      // reassigned it).
      await pool.query("UPDATE analysis_jobs SET lease_owner = 'someone-else' WHERE job_id = $1", [job.jobId]);

      // Give the periodic heartbeat one chance to notice the fencing failure.
      await sleep(100);
      const querySpy = spyOnQuery();
      await sleep(100);
      expect(renewCallCount(querySpy)).toBe(0); // no renewal attempts once the loss was detected
    } finally {
      gate.resolve({ text: validJson, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } });
      await runPromise;
    }
  });

  it("never runs two lease-renewal calls concurrently, even when a renewal itself is slow", async () => {
    await activeSession();
    const lesson = await makeLesson();
    await createJob(pool, lesson.id, "fp-no-overlap");
    const gate = makeGate<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>();
    const deps = makeDeps({ analyzeVideo: vi.fn(() => gate.promise) }, 15);

    const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let inFlight = 0;
    let maxObservedConcurrent = 0;
    (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const sql = args[0];
      const isRenew = typeof sql === "string" && sql.includes("current_stage = COALESCE");
      if (!isRenew) return originalQuery(...args);
      inFlight++;
      maxObservedConcurrent = Math.max(maxObservedConcurrent, inFlight);
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          originalQuery(...args).then(resolve, reject).finally(() => {
            inFlight--;
          });
        }, 40); // deliberately slower than the 15ms tick interval
      });
    };

    const runPromise = runWorkerLoop(deps);
    try {
      await sleep(150);
      expect(maxObservedConcurrent).toBeLessThanOrEqual(1);
    } finally {
      gate.resolve({ text: validJson, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } });
      await runPromise;
      (pool as unknown as { query: (...args: unknown[]) => unknown }).query = originalQuery;
    }
  });

  it("a worker whose lease was reclaimed mid-analysis cannot persist a lesson_analyses row or mark the job succeeded", async () => {
    await activeSession();
    const lesson = await makeLesson();
    const fingerprint = "fp-fenced-no-commit";
    const job = await createJob(pool, lesson.id, fingerprint);
    const gate = makeGate<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>();
    const deps = makeDeps({ analyzeVideo: vi.fn(() => gate.promise) }, 20);

    const runPromise = runWorkerLoop(deps);
    try {
      await waitForJobStatus(job.jobId, "ANALYZING");
      await pool.query(
        "UPDATE analysis_jobs SET lease_owner = 'someone-else', lease_expires_at = now() + interval '2 minutes' WHERE job_id = $1",
        [job.jobId],
      );
      await sleep(60); // let the periodic heartbeat notice the loss before Gemini "finishes"
    } finally {
      gate.resolve({ text: validJson, usage: { inputTokens: 1000, outputTokens: 100, thinkingTokens: 10 } });
      await runPromise;
    }

    expect(await findLatestByFingerprint(pool, fingerprint)).toBeNull();
    const finalJob = await getJob(pool, job.jobId);
    expect(finalJob?.status).not.toBe("COMPLETED");
    expect(finalJob?.leaseOwner).toBe("someone-else");
  });

  it("processing a second lesson does not retain or leak the first lesson's heartbeat timer", async () => {
    await activeSession();
    const lessonA = await makeLesson();
    const lessonB = await makeLesson();
    await createJob(pool, lessonA.id, "fp-seq-a");
    await createJob(pool, lessonB.id, "fp-seq-b");
    const deps = makeDeps({}, 20);

    const querySpy = spyOnQuery();
    await runWorkerLoop(deps); // claims and processes both jobs sequentially, then exits
    const countAfterLoopExits = renewCallCount(querySpy);

    await sleep(150); // several intervals' worth — nothing should still be ticking for either lesson
    expect(renewCallCount(querySpy)).toBe(countAfterLoopExits);

    expect((await findLatestByFingerprint(pool, "fp-seq-a"))?.status).toBe("completed");
    expect((await findLatestByFingerprint(pool, "fp-seq-b"))?.status).toBe("completed");
  });
});
