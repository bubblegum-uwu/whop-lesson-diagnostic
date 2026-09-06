import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import {
  createJob,
  getJob,
  claimNextEligibleJob,
  hasEligibleWork,
  renewLease,
  markSucceeded,
  markForRetry,
  markFailed,
  markAuthRequired,
  resetForManualRetry,
  cancelIfQueued,
  resumeAllAuthRequiredJobs,
} from "../src/db/analysisJobsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

// claimNextEligibleJob picks the globally-earliest eligible row (ORDER BY
// queued_at) — without this, a QUEUED row left over from an earlier test
// (e.g. the deliberately-unclaimed loser of a concurrency race) would be
// claimed instead of the row a given test just created.
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

describe("analysisJobsRepo", () => {
  it("creates a QUEUED job and claims it, incrementing attempt_count and setting a lease", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-1");
    expect(job.status).toBe("QUEUED");
    expect(job.attemptCount).toBe(0);

    const claimed = await claimNextEligibleJob(pool, "owner-a");
    expect(claimed?.jobId).toBe(job.jobId);
    expect(claimed?.status).toBe("RETRIEVING");
    expect(claimed?.attemptCount).toBe(1);
    expect(claimed?.leaseOwner).toBe("owner-a");
  });

  it("does not reclaim an active (non-expired) lease — two concurrent claimers never get the same job", async () => {
    const lesson = await makeLesson();
    await createJob(pool, lesson.id, "fp-2");

    const [a, b] = await Promise.all([
      claimNextEligibleJob(pool, "owner-a"),
      claimNextEligibleJob(pool, "owner-b"),
    ]);
    // Exactly one of the two calls got the job; the other got null (only one job exists).
    const claimedCount = [a, b].filter((x) => x !== null).length;
    expect(claimedCount).toBe(1);
  });

  it("reclaims a job whose lease has expired (crash recovery)", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-3");
    await claimNextEligibleJob(pool, "owner-a");
    // Simulate a crashed worker: force the lease into the past.
    await pool.query(`UPDATE analysis_jobs SET lease_expires_at = now() - interval '1 minute' WHERE job_id = $1`, [
      job.jobId,
    ]);

    const reclaimed = await claimNextEligibleJob(pool, "owner-b");
    expect(reclaimed?.jobId).toBe(job.jobId);
    expect(reclaimed?.leaseOwner).toBe("owner-b");
    expect(reclaimed?.attemptCount).toBe(2);
  });

  it("renewLease is fenced: a stale owner's renewal is rejected once the lease moved to someone else", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-4");
    await claimNextEligibleJob(pool, "owner-a");
    await pool.query(`UPDATE analysis_jobs SET lease_owner = 'owner-b' WHERE job_id = $1`, [job.jobId]);

    const ok = await renewLease(pool, job.jobId, "owner-a", { status: "ANALYZING" });
    expect(ok).toBe(false);

    const stillOk = await renewLease(pool, job.jobId, "owner-b", { status: "ANALYZING" });
    expect(stillOk).toBe(true);
  });

  it("markSucceeded is fenced and sets a terminal status", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-5");
    await claimNextEligibleJob(pool, "owner-a");

    const wrongOwner = await markSucceeded(pool, job.jobId, "owner-b", "COMPLETED");
    expect(wrongOwner).toBe(false);

    const ok = await markSucceeded(pool, job.jobId, "owner-a", "COMPLETED");
    expect(ok).toBe(true);
    const final = await getJob(pool, job.jobId);
    expect(final?.status).toBe("COMPLETED");
    expect(final?.leaseOwner).toBeNull();
  });

  it("markForRetry returns the job to QUEUED with a future next_retry_at, not immediately re-claimable", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-6");
    await claimNextEligibleJob(pool, "owner-a");

    const future = new Date(Date.now() + 60_000);
    await markForRetry(pool, job.jobId, "owner-a", future, "transient", "Gemini 503");

    const notYet = await claimNextEligibleJob(pool, "owner-b");
    expect(notYet).toBeNull();

    await pool.query(`UPDATE analysis_jobs SET next_retry_at = now() - interval '1 second' WHERE job_id = $1`, [
      job.jobId,
    ]);
    const dueNow = await claimNextEligibleJob(pool, "owner-b");
    expect(dueNow?.jobId).toBe(job.jobId);
  });

  it("markFailed is terminal and permanent errors are never auto-retried", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-7");
    await claimNextEligibleJob(pool, "owner-a");
    await markFailed(pool, job.jobId, "owner-a", "permanent", "schema validation failed");

    const claimed = await claimNextEligibleJob(pool, "owner-b");
    expect(claimed).toBeNull();
    const final = await getJob(pool, job.jobId);
    expect(final?.status).toBe("FAILED");
  });

  it("markAuthRequired parks the job — it is not claimable until explicitly resumed", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-8");
    await claimNextEligibleJob(pool, "owner-a");
    await markAuthRequired(pool, job.jobId, "owner-a");

    expect(await claimNextEligibleJob(pool, "owner-b")).toBeNull();
    expect(await hasEligibleWork(pool)).toBe(false);
  });

  it("resumeAllAuthRequiredJobs moves AUTH_REQUIRED jobs back to QUEUED", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-9");
    await claimNextEligibleJob(pool, "owner-a");
    await markAuthRequired(pool, job.jobId, "owner-a");

    const resumed = await resumeAllAuthRequiredJobs(pool);
    expect(resumed).toBeGreaterThanOrEqual(1);
    const final = await getJob(pool, job.jobId);
    expect(final?.status).toBe("QUEUED");
  });

  it("resetForManualRetry only works on FAILED/AUTH_REQUIRED jobs", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-10");
    // Still QUEUED — not retryable.
    expect(await resetForManualRetry(pool, job.jobId)).toBeNull();

    await claimNextEligibleJob(pool, "owner-a");
    await markFailed(pool, job.jobId, "owner-a", "permanent", "boom");
    const reset = await resetForManualRetry(pool, job.jobId);
    expect(reset?.status).toBe("QUEUED");
    expect(reset?.sanitizedError).toBeNull();
  });

  it("cancelIfQueued only cancels a job that is still QUEUED", async () => {
    const lesson = await makeLesson();
    const job = await createJob(pool, lesson.id, "fp-11");
    await claimNextEligibleJob(pool, "owner-a");
    // Now RETRIEVING, not QUEUED.
    expect(await cancelIfQueued(pool, job.jobId)).toBe(false);

    const other = await createJob(pool, lesson.id, "fp-12");
    expect(await cancelIfQueued(pool, other.jobId)).toBe(true);
    const final = await getJob(pool, other.jobId);
    expect(final?.status).toBe("CANCELLED");
  });
});
