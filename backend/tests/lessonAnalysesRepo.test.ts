import { describe, it, expect, afterAll } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createJob } from "../src/db/analysisJobsRepo.js";
import { createLessonAnalysis, findLatestByFingerprint, getByJobId } from "../src/db/lessonAnalysesRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import type { LessonStrategyAnalysis } from "../src/gemini/schema.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
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

function analysis(overrides: Partial<LessonStrategyAnalysis> = {}): LessonStrategyAnalysis {
  return { lesson: { title: "t", duration_seconds: 600 }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE, ...overrides };
}

describe("lessonAnalysesRepo", () => {
  it("creates an analysis row and finds it by fingerprint", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-unique-1");
    const created = await createLessonAnalysis(pool, {
      lessonId: lesson.id,
      jobId: job.jobId,
      status: "no_strategy",
      strategyFound: false,
      validatedJson: analysis(),
      analysisSummary: "No concrete trading strategy taught.",
      model: "gemini-3.8-flash",
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: "fp-unique-1",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 120,
      inputTokens: 1000,
      outputTokens: 100,
      thinkingTokens: 10,
      estimatedCost: 0.01,
    });

    const found = await findLatestByFingerprint(pool, "fp-unique-1");
    expect(found?.analysisId).toBe(created.analysisId);

    const byJob = await getByJobId(pool, job.jobId);
    expect(byJob?.analysisId).toBe(created.analysisId);
  });

  it("enforces UNIQUE(job_id) — a job can produce at most one successful analysis row", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-unique-2");
    const input = {
      lessonId: lesson.id,
      jobId: job.jobId,
      status: "no_strategy" as const,
      strategyFound: false,
      validatedJson: analysis(),
      analysisSummary: "No concrete trading strategy taught.",
      model: "gemini-3.8-flash",
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: "fp-unique-2",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 60,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
    };
    await createLessonAnalysis(pool, input);
    await expect(createLessonAnalysis(pool, input)).rejects.toThrow();
  });

  it("allows a second successful analysis with the SAME fingerprint for a force re-analyze (different job_id)", async () => {
    const lesson = await makeLesson();
    const jobA = await createJob(pool, lesson.id, "fp-shared");
    const jobB = await createJob(pool, lesson.id, "fp-shared");

    const base = {
      lessonId: lesson.id,
      status: "completed" as const,
      strategyFound: true,
      validatedJson: analysis({ strategy_found: true }),
      analysisSummary: "summary",
      model: "gemini-3.8-flash",
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: "fp-shared",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 60,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
    };
    await createLessonAnalysis(pool, { ...base, jobId: jobA.jobId });
    await expect(createLessonAnalysis(pool, { ...base, jobId: jobB.jobId })).resolves.toBeDefined();
  });
});
