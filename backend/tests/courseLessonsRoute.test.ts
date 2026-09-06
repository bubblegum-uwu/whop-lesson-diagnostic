import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";
import { createCourseLessonsHandler } from "../src/http/routes/courseLessons.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
});

describe("GET /api/course/lessons (PR2 job/analysis join)", () => {
  it("reports NOT_ANALYZED for a lesson with no job yet", async () => {
    const courseId = randomId("cors");
    const course = await upsertCourse(pool, { whopCourseId: courseId, whopExperienceId: "exp_1", slug: "s", title: "Course" });
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

    const handler = createCourseLessonsHandler({ pool, whopCourseId: courseId });
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as { lessons: { job: { status: string }; analysis: unknown }[] };
    expect(result.lessons[0].job.status).toBe("NOT_ANALYZED");
    expect(result.lessons[0].analysis).toBeNull();
  });

  it("includes job status/progress and derived analysis output once a job exists", async () => {
    const courseId = randomId("cors");
    const course = await upsertCourse(pool, { whopCourseId: courseId, whopExperienceId: "exp_1", slug: "s", title: "Course" });
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
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status, current_stage) VALUES ($1, 'fp', 'COMPLETED', 'validating_result') RETURNING job_id`,
      [lesson.id],
    );
    await createLessonAnalysis(pool, {
      lessonId: lesson.id,
      jobId: job.rows[0].job_id,
      status: "completed",
      strategyFound: true,
      validatedJson: {
        lesson: { title: "L", duration_seconds: 600 },
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: [],
            timeframes: [],
            indicators: [],
            setup_conditions: [],
            entry_rules: [{ description: "d", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
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
      },
      analysisSummary: "Break & Retest summary",
      model: "gemini-3.8-flash",
      promptVersion: "v1",
      extractorVersion: "v1",
      schemaVersion: "v1",
      analysisFingerprint: "fp",
      startedAt: new Date(),
      completedAt: new Date(),
      processingDurationSeconds: 90,
      inputTokens: 1000,
      outputTokens: 100,
      thinkingTokens: 0,
      estimatedCost: 0.01,
    });

    const handler = createCourseLessonsHandler({ pool, whopCourseId: courseId });
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as {
      lessons: {
        job: { status: string };
        analysis: { extractedStrategiesLabel: string; ruleCounts: unknown[]; confidence: number; summary: string; estimatedCost: number };
      }[];
    };
    expect(result.lessons[0].job.status).toBe("COMPLETED");
    expect(result.lessons[0].analysis.extractedStrategiesLabel).toBe("Break & Retest");
    expect(result.lessons[0].analysis.ruleCounts).toEqual([{ label: "Entry", count: 1 }]);
    expect(result.lessons[0].analysis.confidence).toBe(0.9);
    expect(result.lessons[0].analysis.summary).toBe("Break & Retest summary");
    expect(result.lessons[0].analysis.estimatedCost).toBe(0.01);
  });

  it("exposes the job's leaseExpiresAt so the frontend can tell an expired lease apart from a merely-quiet heartbeat", async () => {
    const courseId = randomId("cors");
    const course = await upsertCourse(pool, { whopCourseId: courseId, whopExperienceId: "exp_1", slug: "s", title: "Course" });
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
    await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status, current_stage, lease_owner, lease_expires_at)
       VALUES ($1, 'fp-lease', 'ANALYZING', 'analyzing_lesson', 'owner-1', now() + interval '2 minutes')`,
      [lesson.id],
    );

    const handler = createCourseLessonsHandler({ pool, whopCourseId: courseId });
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as { lessons: { job: { status: string; leaseExpiresAt: string | null } }[] };
    expect(result.lessons[0].job.status).toBe("ANALYZING");
    expect(result.lessons[0].job.leaseExpiresAt).not.toBeNull();
    expect(new Date(result.lessons[0].job.leaseExpiresAt!).getTime()).toBeGreaterThan(Date.now());
  });
});
