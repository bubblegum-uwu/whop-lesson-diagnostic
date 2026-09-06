import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createEnsureWorkerRunningHandler } from "../src/http/routes/internal.js";
import { InvalidOidcTokenError, type GoogleOidcVerifier } from "../src/lib/googleOidc.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
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

describe("POST /internal/ensure-worker-running", () => {
  it("returns 401 when no Authorization header is present", async () => {
    const oidcVerifier: GoogleOidcVerifier = { verify: vi.fn() };
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger: makeJobTrigger(), oidcVerifier });
    const { res, statusCode } = makeResponse();
    await handler({ headers: {} } as Request, res);
    expect(statusCode()).toBe(401);
    expect(oidcVerifier.verify).not.toHaveBeenCalled();
  });

  it("returns 403 when the identity token does not verify as the configured Scheduler service account — never CORS/Origin/query-secret", async () => {
    const oidcVerifier: GoogleOidcVerifier = {
      verify: vi.fn(async () => {
        throw new InvalidOidcTokenError("wrong identity");
      }),
    };
    const jobTrigger = makeJobTrigger();
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier });
    const { res, statusCode } = makeResponse();
    await handler({ headers: { authorization: "Bearer some-google-token" } } as unknown as Request, res);
    expect(statusCode()).toBe(403);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("triggers a worker execution when eligible work exists", async () => {
    const lesson = await makeLesson();
    await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'QUEUED')`, [lesson.id]);

    const oidcVerifier: GoogleOidcVerifier = { verify: vi.fn(async () => ({ email: "scheduler-sa@x.iam.gserviceaccount.com" })) };
    const jobTrigger = makeJobTrigger();
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier });
    const { res, statusCode } = makeResponse();
    await handler({ headers: { authorization: "Bearer valid-scheduler-token" } } as unknown as Request, res);

    expect(statusCode()).toBe(200);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("does nothing (204) when there is no eligible work", async () => {
    const oidcVerifier: GoogleOidcVerifier = { verify: vi.fn(async () => ({ email: "scheduler-sa@x.iam.gserviceaccount.com" })) };
    const jobTrigger = makeJobTrigger();
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier });

    const res = {
      status: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    await handler({ headers: { authorization: "Bearer valid-scheduler-token" } } as unknown as Request, res as never);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("never auto-converts AUTH_REQUIRED jobs to QUEUED — only a successful operator reconnect may do that", async () => {
    const lesson = await makeLesson();
    await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'AUTH_REQUIRED')`, [
      lesson.id,
    ]);

    const oidcVerifier: GoogleOidcVerifier = { verify: vi.fn(async () => ({ email: "scheduler-sa@x.iam.gserviceaccount.com" })) };
    const jobTrigger = makeJobTrigger();
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier });

    const res = {
      status: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    await handler({ headers: { authorization: "Bearer valid-scheduler-token" } } as unknown as Request, res as never);

    // AUTH_REQUIRED alone is not "eligible work" for this route.
    expect(res.status).toHaveBeenCalledWith(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();

    const stillAuthRequired = await pool.query(`SELECT status FROM analysis_jobs WHERE lesson_id = $1`, [lesson.id]);
    expect(stillAuthRequired.rows[0].status).toBe("AUTH_REQUIRED");
  });
});
