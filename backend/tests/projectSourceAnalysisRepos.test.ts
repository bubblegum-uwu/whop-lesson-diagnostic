import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createJob,
  getJob,
  getLatestJobForProjectSource,
  claimNextEligibleJob,
  renewLease,
  markSucceeded,
  markForRetry,
  markFailed,
  resetForManualRetry,
} from "../src/db/projectSourceAnalysisJobsRepo.js";
import { createProjectSourceAnalysis, findLatestByFingerprint, getLatestByProjectSource, getByJobId } from "../src/db/projectSourceAnalysesRepo.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

// claimNextEligibleJob's WHERE clause has no project_source_id filter — a
// leftover QUEUED/leased row from an earlier test (in this file or another)
// could otherwise be claimed instead of the row a given test just created,
// same reasoning as workerMainLoop.test.ts's own beforeEach truncation.
beforeEach(async () => {
  await pool.query("TRUNCATE project_source_analysis_jobs, project_source_analyses RESTART IDENTITY CASCADE");
});

async function makeProject(): Promise<{ id: number }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [name]);
  return { id: Number(result.rows[0].id) };
}

async function makeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  return source;
}

function analysisInput(projectSourceId: number, jobId: string, overrides: Partial<Parameters<typeof createProjectSourceAnalysis>[1]> = {}) {
  return {
    projectSourceId,
    jobId,
    status: "no_strategy" as const,
    strategyFound: false,
    validatedJson: {
      lesson: { title: "YouTube video", duration_seconds: null },
      strategy_found: false,
      strategies: [],
      knowledge: EMPTY_LESSON_KNOWLEDGE,
    },
    analysisSummary: "No strategy found.",
    model: "gemini-3.8-flash",
    promptVersion: "test",
    extractorVersion: "test",
    schemaVersion: "test",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 5,
    inputTokens: 100,
    outputTokens: 50,
    thinkingTokens: 10,
    estimatedCost: 0.001,
    ...overrides,
  };
}

describe("projectSourceAnalysisJobsRepo", () => {
  it("creates a QUEUED job for a project source", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    expect(job.status).toBe("QUEUED");
    expect(job.projectSourceId).toBe(source.id);
    expect(job.attemptCount).toBe(0);
  });

  it("getLatestJobForProjectSource returns the most recently created job", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, randomId("fp"));
    const second = await createJob(pool, source.id, randomId("fp"));
    const latest = await getLatestJobForProjectSource(pool, source.id);
    expect(latest?.jobId).toBe(second.jobId);
  });

  it("J: claimNextEligibleJob atomically claims a QUEUED job and transitions it to ANALYZING with a lease", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));

    const claimed = await claimNextEligibleJob(pool, "worker-a");
    expect(claimed?.jobId).toBe(job.jobId);
    expect(claimed?.status).toBe("ANALYZING");
    expect(claimed?.leaseOwner).toBe("worker-a");
    expect(claimed?.attemptCount).toBe(1);
  });

  it("J: two concurrent claim attempts for the same job never both succeed (FOR UPDATE SKIP LOCKED)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, randomId("fp"));

    const [a, b] = await Promise.all([claimNextEligibleJob(pool, "worker-a"), claimNextEligibleJob(pool, "worker-b")]);
    const claimedCount = [a, b].filter((x) => x !== null).length;
    expect(claimedCount).toBe(1);
  });

  it("J: a claimed job is not eligible for a second claim until its lease expires", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");

    const second = await claimNextEligibleJob(pool, "worker-b");
    expect(second).toBeNull();
  });

  it("renewLease fails once ownership has moved to a different leaseOwner (fencing)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");

    const renewedByWrongOwner = await renewLease(pool, job.jobId, "worker-b", { status: "VALIDATING" });
    expect(renewedByWrongOwner).toBe(false);

    const renewedByRealOwner = await renewLease(pool, job.jobId, "worker-a", { status: "VALIDATING" });
    expect(renewedByRealOwner).toBe(true);
  });

  it("markSucceeded transitions to COMPLETED/NO_STRATEGY and releases the lease", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");

    const ok = await markSucceeded(pool, job.jobId, "worker-a", "COMPLETED");
    expect(ok).toBe(true);
    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("COMPLETED");
    expect(row?.leaseOwner).toBeNull();
  });

  it("markForRetry returns a job to QUEUED with next_retry_at set", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");

    const future = new Date(Date.now() + 60_000);
    const ok = await markForRetry(pool, job.jobId, "worker-a", future, "transient", "sanitized");
    expect(ok).toBe(true);
    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("QUEUED");
    expect(row?.nextRetryAt).not.toBeNull();

    // Not eligible yet (next_retry_at is in the future).
    const claimed = await claimNextEligibleJob(pool, "worker-b");
    expect(claimed).toBeNull();
  });

  it("V: markFailed transitions to FAILED terminally", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");

    const ok = await markFailed(pool, job.jobId, "worker-a", "permanent", "Video unavailable.");
    expect(ok).toBe(true);
    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("FAILED");
    expect(row?.sanitizedError).toBe("Video unavailable.");
  });

  it("H/W: resetForManualRetry only succeeds while FAILED, and re-queues the SAME job_id (never a duplicate row)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await claimNextEligibleJob(pool, "worker-a");
    await markFailed(pool, job.jobId, "worker-a", "permanent", "err");

    const retried = await resetForManualRetry(pool, job.jobId);
    expect(retried?.jobId).toBe(job.jobId);
    expect(retried?.status).toBe("QUEUED");

    const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("resetForManualRetry refuses a non-FAILED job (e.g. still QUEUED)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));

    const retried = await resetForManualRetry(pool, job.jobId);
    expect(retried).toBeNull();
  });
});

describe("projectSourceAnalysesRepo", () => {
  it("Q: persists an analysis row against project_source_id", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));

    const analysis = await createProjectSourceAnalysis(pool, analysisInput(source.id, job.jobId));
    expect(analysis.projectSourceId).toBe(source.id);
    expect(analysis.jobId).toBe(job.jobId);
  });

  it("UNIQUE(job_id) prevents two analyses from ever being persisted for the same job", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    await createProjectSourceAnalysis(pool, analysisInput(source.id, job.jobId));

    await expect(createProjectSourceAnalysis(pool, analysisInput(source.id, job.jobId))).rejects.toThrow();
  });

  it("findLatestByFingerprint / getLatestByProjectSource / getByJobId all resolve the persisted row", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, randomId("fp"));
    const fingerprint = randomId("fp");
    const analysis = await createProjectSourceAnalysis(pool, analysisInput(source.id, job.jobId, { analysisFingerprint: fingerprint, status: "completed", strategyFound: true }));

    expect((await findLatestByFingerprint(pool, fingerprint))?.analysisId).toBe(analysis.analysisId);
    expect((await getLatestByProjectSource(pool, source.id))?.analysisId).toBe(analysis.analysisId);
    expect((await getByJobId(pool, job.jobId))?.analysisId).toBe(analysis.analysisId);
  });
});
