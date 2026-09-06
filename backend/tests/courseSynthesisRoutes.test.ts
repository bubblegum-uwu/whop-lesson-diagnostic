import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { createStrategyInstances } from "../src/db/strategyInstancesRepo.js";
import { markSynthesisCompleted, claimNextEligibleSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { createStrategyCluster } from "../src/db/strategyClustersRepo.js";
import { createCanonicalStrategy } from "../src/db/canonicalStrategiesRepo.js";
import { createCoursePlaybook } from "../src/db/coursePlaybooksRepo.js";
import { createSynthesisStatusHandler, createSynthesizeHandler, createGetSynthesisHandler } from "../src/http/routes/courseSynthesis.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import type { Strategy } from "../src/gemini/schema.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE synthesis_runs, strategy_clusters, canonical_strategies, course_playbooks RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE courses, lessons RESTART IDENTITY CASCADE");
});

function makeStrategy(): Strategy {
  return {
    strategy_name: "Break & Retest",
    market_or_instrument: ["ES"],
    timeframes: ["5m"],
    indicators: [],
    setup_conditions: [],
    entry_rules: [],
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
  };
}

async function makeCourse(whopCourseId: string) {
  return upsertCourse(pool, { whopCourseId, whopExperienceId: "exp_1", slug: "trading-accelerator", title: "The Trading Accelerator" });
}

/** syncLessons() archives any previously-synced lesson not present in THIS call's list, so every call here re-includes every lesson already synced for the course — a full sync of the current set, not an incremental add. */
async function addAnalyzedLesson(courseId: number, opts: { strategyFound: boolean; title?: string }) {
  const existing = await listLessons(pool, courseId);
  await syncLessons(pool, courseId, [
    ...existing.map((l) => ({
      whopLessonId: l.whopLessonId,
      title: l.title,
      lessonType: l.lessonType,
      visibility: l.visibility,
      chapterWhopId: l.chapterWhopId,
      chapterTitle: l.chapterTitle,
      chapterOrder: l.chapterOrder,
      courseOrder: l.courseOrder,
      durationSeconds: l.durationSeconds,
      videoAssetStatus: l.videoAssetStatus,
      videoAvailable: l.videoAvailable,
      sourceUrl: l.sourceUrl,
    })),
    {
      whopLessonId: randomId("lesn"),
      title: opts.title ?? (opts.strategyFound ? "Break and Retest" : "Sizing & Scaling Trades"),
      lessonType: "video",
      visibility: "visible",
      chapterWhopId: null,
      chapterTitle: null,
      chapterOrder: null,
      courseOrder: existing.length + 1,
      durationSeconds: 600,
      videoAssetStatus: "ready",
      videoAvailable: true,
      sourceUrl: "https://whop.com/x/lessons/y/",
    },
  ]);
  const lessons = await listLessons(pool, courseId);
  const lesson = lessons[lessons.length - 1];

  const jobId = (
    await pool.query(
      `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, $3) RETURNING job_id`,
      [lesson.id, randomId("fp"), opts.strategyFound ? "COMPLETED" : "NO_STRATEGY"],
    )
  ).rows[0].job_id;

  const analysis = await createLessonAnalysis(pool, {
    lessonId: lesson.id,
    jobId,
    status: opts.strategyFound ? "completed" : "no_strategy",
    strategyFound: opts.strategyFound,
    validatedJson: {
      lesson: { title: lesson.title, duration_seconds: 600 },
      strategy_found: opts.strategyFound,
      strategies: opts.strategyFound ? [makeStrategy()] : [],
      knowledge: EMPTY_LESSON_KNOWLEDGE,
    },
    analysisSummary: opts.strategyFound ? "Break & Retest" : "No concrete trading strategy taught.",
    model: GEMINI_MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 60,
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
  if (opts.strategyFound) {
    await createStrategyInstances(pool, analysis.analysisId, lesson.id, [makeStrategy()]);
  }
  return lesson;
}

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

function deps(whopCourseId: string, jobTrigger = makeJobTrigger()) {
  return { pool, whopCourseId, geminiModel: GEMINI_MODEL, jobTrigger };
}

describe("GET /api/course/synthesis-status", () => {
  it("reports course: null when the course has never been synced", async () => {
    const handler = createSynthesisStatusHandler(deps(randomId("cors")));
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect((body() as { course: unknown }).course).toBeNull();
  });

  it("reports counts and canSynthesizeNow once at least one lesson is analyzed", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });
    await addAnalyzedLesson(course.id, { strategyFound: false });

    const handler = createSynthesisStatusHandler(deps(whopCourseId));
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as { counts: { totalLessons: number; analyzed: number }; canSynthesizeNow: boolean; isOutOfDate: boolean; latestCompletedRun: unknown };
    expect(result.counts.totalLessons).toBe(2);
    expect(result.counts.analyzed).toBe(2);
    expect(result.canSynthesizeNow).toBe(true);
    expect(result.isOutOfDate).toBe(false); // no run exists yet at all
    expect(result.latestCompletedRun).toBeNull();
  });

  it("lists lessons with no standalone setup for the frontend coverage banner", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: false, title: "Sizing & Scaling Trades" });

    const handler = createSynthesisStatusHandler(deps(whopCourseId));
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as { noStandaloneSetupLessons: { title: string }[] };
    expect(result.noStandaloneSetupLessons).toHaveLength(1);
    expect(result.noStandaloneSetupLessons[0].title).toBe("Sizing & Scaling Trades");
  });

  it("Phase 3.5B: reports a preflight that flags stale (pre-3.5A v1) analyses and lessons never analyzed at all", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    // addAnalyzedLesson always persists promptVersion/extractorVersion "v1" with a random fingerprint — genuinely stale relative to today's version.
    await addAnalyzedLesson(course.id, { strategyFound: true });
    // A lesson synced but never analyzed at all.
    await syncLessons(pool, course.id, [
      ...(await listLessons(pool, course.id)).map((l) => ({
        whopLessonId: l.whopLessonId,
        title: l.title,
        lessonType: l.lessonType,
        visibility: l.visibility,
        chapterWhopId: l.chapterWhopId,
        chapterTitle: l.chapterTitle,
        chapterOrder: l.chapterOrder,
        courseOrder: l.courseOrder,
        durationSeconds: l.durationSeconds,
        videoAssetStatus: l.videoAssetStatus,
        videoAvailable: l.videoAvailable,
        sourceUrl: l.sourceUrl,
      })),
      {
        whopLessonId: randomId("lesn"),
        title: "Never Analyzed Lesson",
        lessonType: "video",
        visibility: "visible",
        chapterWhopId: null,
        chapterTitle: null,
        chapterOrder: null,
        courseOrder: 2,
        durationSeconds: 300,
        videoAssetStatus: "ready",
        videoAvailable: true,
        sourceUrl: "https://whop.com/x/lessons/z/",
      },
    ]);

    const handler = createSynthesisStatusHandler(deps(whopCourseId));
    const { res, body } = makeResponse();
    await handler({} as Request, res);

    const result = body() as {
      preflight: { lessonCount: number; currentAnalysisCount: number; staleAnalysisCount: number; missingAnalysisCount: number; missingLessonTitles: string[]; ready: boolean };
    };
    expect(result.preflight.lessonCount).toBe(2);
    expect(result.preflight.currentAnalysisCount).toBe(0);
    expect(result.preflight.staleAnalysisCount).toBe(1);
    expect(result.preflight.missingAnalysisCount).toBe(1);
    expect(result.preflight.missingLessonTitles).toEqual(["Never Analyzed Lesson"]);
    expect(result.preflight.ready).toBe(false);
  });

  it("flags an existing completed synthesis as OUT OF DATE once the underlying lesson-analysis set changes", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const jobTrigger = makeJobTrigger();
    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId, jobTrigger));
    const statusHandler = createSynthesisStatusHandler(deps(whopCourseId));

    await synthesizeHandler({ body: {} } as Request, makeResponse().res);
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    await markSynthesisCompleted(pool, claimed!.runId, "owner-a", {
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      estimatedCost: 0.001,
      processingDurationSeconds: 5,
    });

    const beforeNewLesson = makeResponse();
    await statusHandler({} as Request, beforeNewLesson.res);
    expect((beforeNewLesson.body() as { isOutOfDate: boolean }).isOutOfDate).toBe(false);

    // A new lesson finishes analysis after the run completed — the source set has changed.
    await addAnalyzedLesson(course.id, { strategyFound: true, title: "Order Blocks and Liquidity Sweeps" });

    const afterNewLesson = makeResponse();
    await statusHandler({} as Request, afterNewLesson.res);
    const result = afterNewLesson.body() as { isOutOfDate: boolean; counts: { totalLessons: number } };
    expect(result.counts.totalLessons).toBe(2);
    expect(result.isOutOfDate).toBe(true);
  });

  interface RunProgressFields {
    status: string;
    currentStage: string | null;
    stageIndex: number;
    totalStages: number;
    stageLabel: string;
    overallProgress: number;
    stageProgress: number | null;
    isCountable: boolean;
    isIndeterminate: boolean;
    completedItems: number | null;
    totalItems: number | null;
    currentItem: string | null;
    heartbeatTier: string;
    sanitizedError: string | null;
  }

  it("exposes real, safe progress/heartbeat fields for a RUNNING synthesis — never a generic spinner-only state", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId));
    const statusHandler = createSynthesisStatusHandler(deps(whopCourseId));
    await synthesizeHandler({ body: {} } as Request, makeResponse().res);
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");

    // Simulates the worker having persisted real mid-flight progress (see worker/synthesisLoop.ts) — the API must read this back, never hold its own copy.
    await pool.query(
      `UPDATE synthesis_runs SET current_stage = 'CANONICALIZING', completed_items = 1, total_items = 4, current_item = 'Break & Retest' WHERE run_id = $1`,
      [claimed!.runId],
    );

    const { res, body } = makeResponse();
    await statusHandler({} as Request, res);
    const result = body() as { latestRun: RunProgressFields };

    expect(result.latestRun.status).toBe("RUNNING");
    expect(result.latestRun.currentStage).toBe("CANONICALIZING");
    expect(result.latestRun.stageIndex).toBe(3);
    expect(result.latestRun.totalStages).toBe(7);
    expect(result.latestRun.stageLabel).toBe("Building Canonical Strategies");
    expect(result.latestRun.isCountable).toBe(true);
    expect(result.latestRun.isIndeterminate).toBe(false);
    expect(result.latestRun.stageProgress).toBe(25);
    expect(result.latestRun.completedItems).toBe(1);
    expect(result.latestRun.totalItems).toBe(4);
    expect(result.latestRun.currentItem).toBe("Break & Retest");
    expect(result.latestRun.heartbeatTier).toBe("none"); // just claimed — heartbeat is fresh
    expect(result.latestRun.overallProgress).toBeGreaterThan(0);
    expect(result.latestRun.overallProgress).toBeLessThan(100);
  });

  it("reloads progress fresh from Postgres on every call — a later call reflects a change with no request-scoped or in-memory state carried over", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId));
    const statusHandler = createSynthesisStatusHandler(deps(whopCourseId));
    await synthesizeHandler({ body: {} } as Request, makeResponse().res);
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");

    await pool.query(`UPDATE synthesis_runs SET current_stage = 'CLUSTERING', completed_items = 0, total_items = 1 WHERE run_id = $1`, [claimed!.runId]);
    const first = makeResponse();
    await statusHandler({} as Request, first.res);
    expect((first.body() as { latestRun: RunProgressFields }).latestRun.overallProgress).toBe(5); // NORMALIZING done in full, CLUSTERING just started

    // A brand-new handler instance (fresh closure, exactly as a new HTTP
    // request would get) — proves the reload comes from Postgres, not a
    // variable held over from the first call.
    const secondStatusHandler = createSynthesisStatusHandler(deps(whopCourseId));
    await pool.query(`UPDATE synthesis_runs SET current_stage = 'CANONICALIZING', completed_items = 4, total_items = 4 WHERE run_id = $1`, [claimed!.runId]);
    const second = makeResponse();
    await secondStatusHandler({} as Request, second.res);
    expect((second.body() as { latestRun: RunProgressFields }).latestRun.overallProgress).toBe(55); // NORMALIZING+CLUSTERING done (20) + CANONICALIZING done in full (35)
  });

  it("a COMPLETED run always reports 100% overall progress", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId));
    const statusHandler = createSynthesisStatusHandler(deps(whopCourseId));
    await synthesizeHandler({ body: {} } as Request, makeResponse().res);
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    await markSynthesisCompleted(pool, claimed!.runId, "owner-a", {
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      estimatedCost: 0.01,
      processingDurationSeconds: 5,
    });

    const { res, body } = makeResponse();
    await statusHandler({} as Request, res);
    const result = body() as { latestRun: RunProgressFields };
    expect(result.latestRun.status).toBe("COMPLETED");
    expect(result.latestRun.overallProgress).toBe(100);
    expect(result.latestRun.heartbeatTier).toBe("none");
  });

  it("a FAILED run preserves and exposes the last known stage/progress reached, plus the safe sanitized error — never prompt content", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId));
    const statusHandler = createSynthesisStatusHandler(deps(whopCourseId));
    await synthesizeHandler({ body: {} } as Request, makeResponse().res);
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");

    // The worker reached CANONICALIZING (2 of 4 clusters) before failing — markSynthesisFailed never touches these progress columns.
    await pool.query(
      `UPDATE synthesis_runs SET current_stage = 'CANONICALIZING', completed_items = 2, total_items = 4, current_item = 'Break & Retest' WHERE run_id = $1`,
      [claimed!.runId],
    );
    await pool.query(
      `UPDATE synthesis_runs SET status = 'FAILED', completed_at = now(), error_type = 'permanent',
         sanitized_error = 'stage=canonical_strategy schema=canonical_strategy_v3 model=gemini-3.8-flash prompt_chars=18420 error=Gemini did not return valid JSON for stage "canonical_strategy".',
         lease_owner = NULL, lease_expires_at = NULL
       WHERE run_id = $1`,
      [claimed!.runId],
    );

    const { res, body } = makeResponse();
    await statusHandler({} as Request, res);
    const result = body() as { latestRun: RunProgressFields };

    expect(result.latestRun.status).toBe("FAILED");
    expect(result.latestRun.currentStage).toBe("CANONICALIZING"); // the stage it actually reached, preserved
    expect(result.latestRun.stageLabel).toBe("Building Canonical Strategies");
    expect(result.latestRun.completedItems).toBe(2);
    expect(result.latestRun.totalItems).toBe(4);
    expect(result.latestRun.overallProgress).toBeGreaterThan(0);
    expect(result.latestRun.overallProgress).toBeLessThan(100);
    expect(result.latestRun.heartbeatTier).toBe("none"); // terminal — never a heartbeat warning
    expect(result.latestRun.sanitizedError).toContain("stage=canonical_strategy");
    expect(result.latestRun.sanitizedError).not.toContain("SUPER SECRET");
  });
});

describe("POST /api/course/synthesize", () => {
  it("refuses to synthesize when nothing has finished analysis yet", async () => {
    const whopCourseId = randomId("cors");
    await makeCourse(whopCourseId);
    const handler = createSynthesizeHandler(deps(whopCourseId));
    const { res, statusCode } = makeResponse();
    await handler({ body: {} } as Request, res);
    expect(statusCode()).toBe(409);
  });

  it("creates a QUEUED run and triggers the worker Job when eligible", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });
    const jobTrigger = makeJobTrigger();

    const handler = createSynthesizeHandler(deps(whopCourseId, jobTrigger));
    const { res, statusCode, body } = makeResponse();
    await handler({ body: {} } as Request, res);

    expect(statusCode()).toBe(202);
    const result = body() as { created: boolean; run: { status: string } };
    expect(result.created).toBe(true);
    expect(result.run.status).toBe("QUEUED");
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a plain re-synthesize with an unchanged source returns the existing completed run instead of creating a new one", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const jobTrigger = makeJobTrigger();
    const handler = createSynthesizeHandler(deps(whopCourseId, jobTrigger));

    const first = makeResponse();
    await handler({ body: {} } as Request, first.res);
    const firstRun = (first.body() as { run: { runId: string } }).run;

    // Simulate the worker completing that run.
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    await markSynthesisCompleted(pool, claimed!.runId, "owner-a", {
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      estimatedCost: 0.001,
      processingDurationSeconds: 5,
    });

    const second = makeResponse();
    await handler({ body: {} } as Request, second.res);
    const secondResult = second.body() as { created: boolean; run: { runId: string } };
    expect(secondResult.created).toBe(false);
    expect(secondResult.run.runId).toBe(firstRun.runId);
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1); // never called again for the no-op
  });

  it("force always creates a new run even when the source is unchanged", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const jobTrigger = makeJobTrigger();
    const handler = createSynthesizeHandler(deps(whopCourseId, jobTrigger));

    const first = makeResponse();
    await handler({ body: {} } as Request, first.res);
    const firstRun = (first.body() as { run: { runId: string } }).run;
    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    await markSynthesisCompleted(pool, claimed!.runId, "owner-a", { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, estimatedCost: 0.001, processingDurationSeconds: 5 });

    const second = makeResponse();
    await handler({ body: { force: true } } as Request, second.res);
    const secondResult = second.body() as { created: boolean; run: { runId: string } };
    expect(secondResult.created).toBe(true);
    expect(secondResult.run.runId).not.toBe(firstRun.runId);
  });
});

describe("GET /api/course/synthesis", () => {
  it("returns run: null when no run has ever completed", async () => {
    const whopCourseId = randomId("cors");
    await makeCourse(whopCourseId);
    const handler = createGetSynthesisHandler(deps(whopCourseId));
    const { res, body } = makeResponse();
    await handler({} as Request, res);
    expect((body() as { run: unknown }).run).toBeNull();
  });

  it("returns the full completed run's clusters, canonical strategies, and playbook", async () => {
    const whopCourseId = randomId("cors");
    const course = await makeCourse(whopCourseId);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const jobTrigger = makeJobTrigger();
    const synthesizeHandler = createSynthesizeHandler(deps(whopCourseId, jobTrigger));
    const created = makeResponse();
    await synthesizeHandler({ body: {} } as Request, created.res);
    const runId = (created.body() as { run: { runId: string } }).run.runId;

    const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
    const clusterRow = await createStrategyCluster(pool, claimed!.runId, {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1],
      similarityRationale: "r",
      differencesNotes: "",
    });
    await createCanonicalStrategy(pool, claimed!.runId, clusterRow.clusterId, {
      name: "Break & Retest",
      purpose: "p",
      markets: ["ES"],
      timeframes: ["5m"],
      marketContext: [],
      prerequisites: [],
      setup: [],
      entryRules: [],
      confirmationRules: [],
      stopLossRules: [],
      profitTargetRules: [],
      tradeManagementRules: [],
      invalidationRules: [],
      noTradeConditions: [],
      visualDiscretionaryRules: [],
      riskManagementRules: [],
      positionSizingRules: [],
      scalingInRules: [],
      scalingOutRules: [],
      runnerManagementRules: [],
      warnings: [],
      instructorPreferences: [],
      variants: [],
      examples: [],
      ambiguities: [],
      conflicts: [],
      sourceLessonIds: [1],
      supportingKnowledgeLessonIds: [],
    });
    await createCoursePlaybook(pool, {
      runId: claimed!.runId,
      title: "Playbook",
      coreFramework: { sections: [] },
      playbook: {
        title: "Playbook",
        sections: [],
        conflictsAndAmbiguities: [],
        frameworkCoverage: {
          status: "COMPLETE",
          standaloneStrategyLessonsAnalyzed: 1,
          lessonsWithoutStandaloneSetup: 0,
          lessonsMissingSupportingKnowledgeExtraction: 0,
          missingSupportingKnowledgeLessonIds: [],
          missingSupportingKnowledgeLessonTitles: [],
          missingFrameworkDimensions: [],
          coverageNote: "current",
        },
        strategyScopeMapping: {
          distinctRawNameCount: 0,
          matchedRawNameCount: 0,
          unmatchedRawNameCount: 0,
          matchedRawNames: [],
          unmatchedRawNames: [],
          totalStrategyScopedItemCount: 0,
          matchedItemCount: 0,
          unmatchedItemCount: 0,
          completeness: "COMPLETE",
        },
      },
      decisionFramework: { nodes: [], readableSteps: [] },
    });
    await markSynthesisCompleted(pool, claimed!.runId, "owner-a", { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, estimatedCost: 0.001, processingDurationSeconds: 5 });
    void runId;

    const getHandler = createGetSynthesisHandler(deps(whopCourseId));
    const { res, body } = makeResponse();
    await getHandler({} as Request, res);
    const result = body() as {
      run: { runId: string };
      clusters: { canonicalName: string }[];
      canonicalStrategies: { name: string }[];
      playbook: { frameworkCoverage: { status: string } };
    };
    expect(result.run.runId).toBe(claimed!.runId);
    expect(result.clusters[0].canonicalName).toBe("Break & Retest");
    expect(result.canonicalStrategies[0].name).toBe("Break & Retest");
    expect(result.playbook.frameworkCoverage.status).toBe("COMPLETE");
  });
});
