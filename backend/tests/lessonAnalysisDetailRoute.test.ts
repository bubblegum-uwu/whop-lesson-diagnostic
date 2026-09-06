import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { createLessonAnalysisDetailHandler } from "../src/http/routes/lessonAnalysisDetail.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
});

describe("GET /api/course/lessons/:lessonId/analysis", () => {
  it("returns 404 when no analysis exists yet", async () => {
    const handler = createLessonAnalysisDetailHandler({ pool });
    const { res, statusCode } = makeResponse();
    await handler({ params: { lessonId: "999999" } } as unknown as Request, res);
    expect(statusCode()).toBe(404);
  });

  it("returns 400 for a non-numeric lesson id", async () => {
    const handler = createLessonAnalysisDetailHandler({ pool });
    const { res, statusCode } = makeResponse();
    await handler({ params: { lessonId: "not-a-number" } } as unknown as Request, res);
    expect(statusCode()).toBe(400);
  });

  async function makeLesson() {
    const course = await upsertCourse(pool, { whopCourseId: randomId("cors"), whopExperienceId: "exp_1", slug: "s", title: "Course" });
    await syncLessons(pool, course.id, [
      {
        whopLessonId: randomId("lesn"),
        title: "L",
        lessonType: "video",
        visibility: "visible",
        chapterWhopId: null,
        chapterTitle: null,
        chapterOrder: null,
        courseOrder: 1,
        durationSeconds: 600,
        videoAssetStatus: "ready",
        videoAvailable: true,
        sourceUrl: "https://whop.com/s/exp_1/app/courses/x/lessons/y/",
      },
    ]);
    const [lesson] = await listLessons(pool, course.id);
    const job = await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'COMPLETED') RETURNING job_id`,
      [lesson.id],
    );
    return { lesson, jobId: job.rows[0].job_id as string };
  }

  it("returns the full validated JSON for the lesson's latest analysis (v2, already carrying knowledge)", async () => {
    const { lesson, jobId } = await makeLesson();
    const validatedJson = {
      lesson: { title: "L", duration_seconds: 600 },
      strategy_found: false,
      strategies: [],
      knowledge: { summary: "s", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
    };
    await createLessonAnalysis(pool, {
      lessonId: lesson.id,
      jobId,
      status: "no_strategy",
      strategyFound: false,
      validatedJson,
      analysisSummary: "s",
      model: "gemini-3.8-flash",
      promptVersion: "v2",
      extractorVersion: "v2",
      schemaVersion: "v2",
      analysisFingerprint: "fp",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 60,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
    });

    const handler = createLessonAnalysisDetailHandler({ pool });
    const { res, statusCode, body } = makeResponse();
    await handler({ params: { lessonId: String(lesson.id) } } as unknown as Request, res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({ validatedJson });
  });

  // Phase 3.5 / test scenario #22: a v1 row (persisted before this feature
  // existed) has NO `knowledge` field in its stored JSON at all — reading
  // it back must not crash, and must not silently pretend content exists.
  // It's backfilled with empty defaults (never fabricated) so every
  // downstream consumer can safely assume `.knowledge` is always present.
  it("normalizes a pre-v2 analysis (no `knowledge` in the stored JSON) with empty defaults on read — old analyses remain fully readable", async () => {
    const { lesson, jobId } = await makeLesson();
    const v1ValidatedJson = { lesson: { title: "L", duration_seconds: 600 }, strategy_found: false, strategies: [] };
    await createLessonAnalysis(pool, {
      lessonId: lesson.id,
      jobId,
      status: "no_strategy",
      strategyFound: false,
      validatedJson: v1ValidatedJson as never,
      analysisSummary: "No concrete trading strategy taught.",
      model: "gemini-3.8-flash",
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: "fp",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 60,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
    });

    const handler = createLessonAnalysisDetailHandler({ pool });
    const { res, statusCode, body } = makeResponse();
    await handler({ params: { lessonId: String(lesson.id) } } as unknown as Request, res);

    expect(statusCode()).toBe(200);
    expect(body()).toEqual({
      validatedJson: { ...v1ValidatedJson, knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] } },
    });
  });
});
