import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import {
  createSynthesisRun,
  getSynthesisRun,
  getLatestCompletedRun,
  getLatestRun,
  claimNextEligibleSynthesisRun,
  hasEligibleSynthesisWork,
  renewSynthesisLease,
  markSynthesisCompleted,
  markSynthesisFailed,
} from "../src/db/synthesisRunsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE synthesis_runs, strategy_clusters, canonical_strategies, course_playbooks RESTART IDENTITY CASCADE");
});

async function makeCourse() {
  return upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_1",
    slug: "trading-accelerator",
    title: "The Trading Accelerator",
  });
}

const RUN_INPUT_DEFAULTS = {
  sourceAnalysisHash: "hash-1",
  sourceAnalysisIds: [1, 2, 3],
  model: "gemini-3.8-flash",
  synthesisPromptVersion: "v1",
  synthesisSchemaVersion: "v1",
  synthesizerVersion: "v1",
};

describe("synthesisRunsRepo", () => {
  it("creates a QUEUED run and reads it back", async () => {
    const course = await makeCourse();
    const created = await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    expect(created.status).toBe("QUEUED");
    expect(created.sourceAnalysisIds).toEqual([1, 2, 3]);

    const fetched = await getSynthesisRun(pool, created.runId);
    expect(fetched?.runId).toBe(created.runId);
  });

  it("claims a QUEUED run, fencing subsequent claims by another owner", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });

    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    expect(claimed?.status).toBe("RUNNING");
    expect(claimed?.leaseOwner).toBe("owner-a");

    const second = await claimNextEligibleSynthesisRun(pool, "owner-b");
    expect(second).toBeNull(); // nothing else eligible
  });

  it("reports eligible work only while a run is QUEUED or lease-expired RUNNING", async () => {
    const course = await makeCourse();
    expect(await hasEligibleSynthesisWork(pool)).toBe(false);

    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    expect(await hasEligibleSynthesisWork(pool)).toBe(true);

    const run = await claimNextEligibleSynthesisRun(pool, "owner-a");
    expect(await hasEligibleSynthesisWork(pool)).toBe(false); // now RUNNING with a fresh, unexpired lease

    // Simulate a crashed worker: force the lease into the past.
    await pool.query("UPDATE synthesis_runs SET lease_expires_at = now() - interval '1 minute' WHERE run_id = $1", [run!.runId]);
    expect(await hasEligibleSynthesisWork(pool)).toBe(true);
  });

  it("renews a held lease and reports current_stage, fenced by lease_owner", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    const run = await claimNextEligibleSynthesisRun(pool, "owner-a");

    const ok = await renewSynthesisLease(pool, run!.runId, "owner-a", "clustering");
    expect(ok).toBe(true);
    const fetched = await getSynthesisRun(pool, run!.runId);
    expect(fetched?.currentStage).toBe("clustering");

    const wrongOwner = await renewSynthesisLease(pool, run!.runId, "owner-b", "playbook");
    expect(wrongOwner).toBe(false);
  });

  it("marks a run COMPLETED with usage/cost, fenced by lease_owner", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    const run = await claimNextEligibleSynthesisRun(pool, "owner-a");

    const ok = await markSynthesisCompleted(pool, run!.runId, "owner-a", {
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: 50,
      estimatedCost: 0.05,
      processingDurationSeconds: 120,
    });
    expect(ok).toBe(true);

    const fetched = await getSynthesisRun(pool, run!.runId);
    expect(fetched?.status).toBe("COMPLETED");
    expect(fetched?.estimatedCost).toBe(0.05);

    const latestCompleted = await getLatestCompletedRun(pool, course.id);
    expect(latestCompleted?.runId).toBe(run!.runId);
  });

  it("does not complete a run whose lease was reclaimed", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    const run = await claimNextEligibleSynthesisRun(pool, "owner-a");
    await pool.query("UPDATE synthesis_runs SET lease_owner = 'owner-b' WHERE run_id = $1", [run!.runId]);

    const ok = await markSynthesisCompleted(pool, run!.runId, "owner-a", {
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      estimatedCost: null,
      processingDurationSeconds: null,
    });
    expect(ok).toBe(false);
    expect((await getSynthesisRun(pool, run!.runId))?.status).toBe("RUNNING");
  });

  it("marks a run FAILED with a sanitized error", async () => {
    const course = await makeCourse();
    await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS });
    const run = await claimNextEligibleSynthesisRun(pool, "owner-a");

    const ok = await markSynthesisFailed(pool, run!.runId, "owner-a", "permanent", "Gemini output failed schema validation.");
    expect(ok).toBe(true);
    const fetched = await getSynthesisRun(pool, run!.runId);
    expect(fetched?.status).toBe("FAILED");
    expect(fetched?.sanitizedError).toContain("schema validation");
  });

  it("getLatestRun returns the most recent run regardless of status", async () => {
    const course = await makeCourse();
    const first = await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS, sourceAnalysisHash: "hash-1" });
    await markSynthesisFailed(pool, (await claimNextEligibleSynthesisRun(pool, "owner-a"))!.runId, "owner-a", "permanent", "e");
    void first;

    const second = await createSynthesisRun(pool, { courseId: course.id, ...RUN_INPUT_DEFAULTS, sourceAnalysisHash: "hash-2" });
    const latest = await getLatestRun(pool, course.id);
    expect(latest?.runId).toBe(second.runId);
    expect(latest?.status).toBe("QUEUED");
  });
});
