import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createEnsureWorkerRunningHandler } from "../src/http/routes/internal.js";
import { createSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { InvalidOidcTokenError, type GoogleOidcVerifier } from "../src/lib/googleOidc.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events, synthesis_runs, strategy_clusters, canonical_strategies, course_playbooks RESTART IDENTITY CASCADE",
  );
});

const SYNTHESIS_RUN_DEFAULTS = {
  sourceAnalysisHash: "hash-1",
  sourceAnalysisIds: [1, 2, 3],
  model: "gemini-3.8-flash",
  synthesisPromptVersion: "v1",
  synthesisSchemaVersion: "v1",
  synthesizerVersion: "v1",
};

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

async function makeCourse() {
  return upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_1",
    slug: "trading-accelerator",
    title: "The Trading Accelerator",
  });
}

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

function verifiedOidc(): GoogleOidcVerifier {
  return { verify: vi.fn(async () => ({ email: "scheduler-sa@x.iam.gserviceaccount.com" })) };
}

async function callHandler(pool: Parameters<typeof createEnsureWorkerRunningHandler>[0]["pool"], jobTrigger: JobTrigger) {
  const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier: verifiedOidc() });
  const { res, statusCode } = makeResponse();
  await handler({ headers: { authorization: "Bearer valid-scheduler-token" } } as unknown as Request, res);
  return statusCode();
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

/**
 * Phase 3.5B scheduler recovery fix — the route now recovers durable work
 * for BOTH lesson analysis jobs AND course synthesis runs (see internal.ts's
 * doc comment for the real production failure this closes). These tests
 * exercise the synthesis half in isolation and, in combination with the
 * lesson-work tests above, confirm neither eligibility check's behavior
 * regressed and a worker triggers whenever EITHER kind of durable work is
 * claimable.
 */
describe("POST /internal/ensure-worker-running — synthesis run recovery (Phase 3.5B)", () => {
  it("no lesson work + no synthesis work -> 204, worker not triggered", async () => {
    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("a QUEUED, claimable synthesis run -> worker triggered", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(200);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("a synthesis run with an expired lease -> worker triggered, recovering even though analysis_jobs is empty", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = 'dead-owner', lease_expires_at = now() - interval '1 minute' WHERE run_id = $1`,
      [run.runId],
    );

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(200);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("an active, unexpired-lease synthesis run alone -> worker NOT triggered (nothing claimable right now)", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = 'live-owner', lease_expires_at = now() + interval '5 minutes' WHERE run_id = $1`,
      [run.runId],
    );

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("an active unexpired synthesis run + an eligible lesson job -> worker DOES trigger, because lesson work is eligible", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = 'live-owner', lease_expires_at = now() + interval '5 minutes' WHERE run_id = $1`,
      [run.runId],
    );
    const lesson = await makeLesson();
    await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp', 'QUEUED')`, [lesson.id]);

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(200);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("a COMPLETED synthesis run -> worker not triggered", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'COMPLETED', lease_owner = NULL, lease_expires_at = NULL, completed_at = now() WHERE run_id = $1`,
      [run.runId],
    );

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("a FAILED (terminal) synthesis run -> worker not triggered", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'FAILED', lease_owner = NULL, lease_expires_at = NULL, completed_at = now() WHERE run_id = $1`,
      [run.runId],
    );

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("multiple synthesis runs, at least one claimable -> exactly one worker trigger", async () => {
    const course = await makeCourse();
    const done = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS, sourceAnalysisHash: "hash-done" });
    await pool.query(`UPDATE synthesis_runs SET status = 'COMPLETED', completed_at = now() WHERE run_id = $1`, [done.runId]);
    await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS, sourceAnalysisHash: "hash-queued" });

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(200);
    expect(jobTrigger.triggerRun).toHaveBeenCalledOnce();
  });

  it("OIDC/auth semantics are unchanged: an invalid identity token is still rejected with 403 even when synthesis work is eligible", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });

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

  it("a trigger failure surfaces the same way regardless of which kind of work triggered it (trigger behavior unchanged)", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });

    const jobTrigger: JobTrigger = { triggerRun: vi.fn(async () => { throw new Error("Cloud Run trigger failed"); }) };
    const handler = createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier: verifiedOidc() });
    const { res } = makeResponse();
    await expect(
      handler({ headers: { authorization: "Bearer valid-scheduler-token" } } as unknown as Request, res),
    ).rejects.toThrow("Cloud Run trigger failed");
  });

  it("does not trigger repeatedly solely because an actively-leased synthesis run exists — repeated calls stay 204 while the lease is live", async () => {
    const course = await makeCourse();
    const run = await createSynthesisRun(pool, { courseId: course.id, ...SYNTHESIS_RUN_DEFAULTS });
    await pool.query(
      `UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = 'live-owner', lease_expires_at = now() + interval '5 minutes' WHERE run_id = $1`,
      [run.runId],
    );

    const jobTrigger = makeJobTrigger();
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(await callHandler(pool, jobTrigger)).toBe(204);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });
});
