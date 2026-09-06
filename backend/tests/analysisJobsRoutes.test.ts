import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { getJob } from "../src/db/analysisJobsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import {
  createEnqueueJobsHandler,
  createRetryJobHandler,
  createCancelJobHandler,
} from "../src/http/routes/analysisJobs.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
});

async function makeLesson() {
  const course = await upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_1",
    slug: "scarface-trades-mastermind",
    title: "Scarface Trades Mastermind",
  });
  await syncLessons(pool, course.id, [
    {
      whopLessonId: randomId("lesn"),
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
      sourceUrl: "https://whop.com/x/lessons/y/",
    },
  ]);
  const [lesson] = await listLessons(pool, course.id);
  return lesson;
}

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

describe("POST /api/analysis/jobs", () => {
  it("queues a job per lesson and triggers a worker execution", async () => {
    const lesson = await makeLesson();
    const jobTrigger = makeJobTrigger();
    const handler = createEnqueueJobsHandler({ pool, jobTrigger, geminiModel: GEMINI_MODEL });
    const { res, statusCode, body } = makeResponse();

    await handler({ body: { lessonIds: [lesson.id] } } as Request, res);

    expect(statusCode()).toBe(202);
    const result = body() as { queued: { lessonId: number }[]; skipped: unknown[] };
    expect(result.queued).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("skips a lesson that already has a completed analysis with the same fingerprint, and does not spend Gemini work", async () => {
    const lesson = await makeLesson();
    const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: GEMINI_MODEL });
    const job = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
      [lesson.id, fingerprint],
    );
    await createLessonAnalysis(pool, {
      lessonId: lesson.id,
      jobId: job.rows[0].job_id,
      status: "completed",
      strategyFound: true,
      validatedJson: { lesson: { title: "t", duration_seconds: 600 }, strategy_found: true, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
      analysisSummary: "summary",
      model: GEMINI_MODEL,
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: fingerprint,
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 60,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
    });

    const jobTrigger = makeJobTrigger();
    const handler = createEnqueueJobsHandler({ pool, jobTrigger, geminiModel: GEMINI_MODEL });
    const { res, body } = makeResponse();
    await handler({ body: { lessonIds: [lesson.id] } } as Request, res);

    const result = body() as { queued: unknown[]; skipped: { lessonId: number; reason: string }[] };
    expect(result.queued).toHaveLength(0);
    expect(result.skipped).toEqual([{ lessonId: lesson.id, reason: "already_analyzed" }]);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("force re-queues a lesson even if an identical successful analysis already exists", async () => {
    const lesson = await makeLesson();
    const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: GEMINI_MODEL });
    await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED')`,
      [lesson.id, fingerprint],
    );

    const jobTrigger = makeJobTrigger();
    const handler = createEnqueueJobsHandler({ pool, jobTrigger, geminiModel: GEMINI_MODEL });
    const { res, body } = makeResponse();
    await handler({ body: { lessonIds: [lesson.id], force: true } } as Request, res);

    const result = body() as { queued: unknown[] };
    expect(result.queued).toHaveLength(1);
  });

  it("returns 400 when lessonIds is missing", async () => {
    const handler = createEnqueueJobsHandler({ pool, jobTrigger: makeJobTrigger(), geminiModel: GEMINI_MODEL });
    const { res, statusCode } = makeResponse();
    await handler({ body: {} } as Request, res);
    expect(statusCode()).toBe(400);
  });
});

describe("POST /api/analysis/jobs/:jobId/retry", () => {
  it("returns 409 for a job that is not FAILED/AUTH_REQUIRED", async () => {
    const lesson = await makeLesson();
    const inserted = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'QUEUED') RETURNING job_id`,
      [lesson.id],
    );
    const handler = createRetryJobHandler({ pool, jobTrigger: makeJobTrigger(), geminiModel: GEMINI_MODEL });
    const { res, statusCode } = makeResponse();
    await handler({ params: { jobId: inserted.rows[0].job_id } } as unknown as Request, res);
    expect(statusCode()).toBe(409);
  });

  it("resets a FAILED job to QUEUED and triggers a worker execution", async () => {
    const lesson = await makeLesson();
    const inserted = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status, sanitized_error) VALUES ($1, 'fp', 'FAILED', 'boom') RETURNING job_id`,
      [lesson.id],
    );
    const jobTrigger = makeJobTrigger();
    const handler = createRetryJobHandler({ pool, jobTrigger, geminiModel: GEMINI_MODEL });
    const { res, statusCode } = makeResponse();
    await handler({ params: { jobId: inserted.rows[0].job_id } } as unknown as Request, res);

    expect(statusCode()).toBe(202);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
    const job = await getJob(pool, inserted.rows[0].job_id);
    expect(job?.status).toBe("QUEUED");
  });
});

describe("POST /api/analysis/jobs/:jobId/cancel", () => {
  it("cancels a QUEUED job", async () => {
    const lesson = await makeLesson();
    const inserted = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'QUEUED') RETURNING job_id`,
      [lesson.id],
    );
    const handler = createCancelJobHandler({ pool, jobTrigger: makeJobTrigger(), geminiModel: GEMINI_MODEL });
    const { res, statusCode } = makeResponse();
    await handler({ params: { jobId: inserted.rows[0].job_id } } as unknown as Request, res);
    expect(statusCode()).toBe(200);
  });

  it("refuses to cancel a job that is already processing (documented limitation)", async () => {
    const lesson = await makeLesson();
    const inserted = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'ANALYZING') RETURNING job_id`,
      [lesson.id],
    );
    const handler = createCancelJobHandler({ pool, jobTrigger: makeJobTrigger(), geminiModel: GEMINI_MODEL });
    const { res, statusCode } = makeResponse();
    await handler({ params: { jobId: inserted.rows[0].job_id } } as unknown as Request, res);
    expect(statusCode()).toBe(409);
  });
});
