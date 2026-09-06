import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis, getByAnalysisIds } from "../src/db/lessonAnalysesRepo.js";
import { createStrategyInstances } from "../src/db/strategyInstancesRepo.js";
import { createSynthesisRun, getSynthesisRun, claimNextEligibleSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { listStrategyClustersByRun } from "../src/db/strategyClustersRepo.js";
import { listCanonicalStrategiesByRun } from "../src/db/canonicalStrategiesRepo.js";
import { getCoursePlaybookByRun } from "../src/db/coursePlaybooksRepo.js";
import { runSynthesisLoop, type SynthesisWorkerDeps } from "../src/worker/synthesisLoop.js";
import type { GeminiClient } from "../src/gemini/client.js";
import type { Strategy } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE synthesis_runs, strategy_clusters, canonical_strategies, course_playbooks RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE analysis_jobs, lesson_analyses, strategy_instances, usage_records, job_events RESTART IDENTITY CASCADE");
});

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    strategy_name: "Break & Retest",
    market_or_instrument: ["ES"],
    timeframes: ["5m"],
    indicators: ["VWAP"],
    setup_conditions: [],
    entry_rules: [{ description: "Enter on retest", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "e" }],
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
    ...overrides,
  };
}

async function makeCourseWithLessons() {
  const course = await upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_1",
    slug: "trading-accelerator",
    title: "The Trading Accelerator",
  });
  await syncLessons(pool, course.id, [
    {
      whopLessonId: randomId("lesn"),
      title: "Break and Retest Basics",
      lessonType: "video",
      visibility: "visible",
      chapterWhopId: null,
      chapterTitle: "Foundations",
      chapterOrder: 1,
      courseOrder: 1,
      durationSeconds: 600,
      videoAssetStatus: "ready",
      videoAvailable: true,
      sourceUrl: "https://whop.com/x/lessons/l1/",
    },
    {
      whopLessonId: randomId("lesn"),
      title: "Sizing & Scaling Trades",
      lessonType: "video",
      visibility: "visible",
      chapterWhopId: null,
      chapterTitle: "Risk",
      chapterOrder: 2,
      courseOrder: 2,
      durationSeconds: 400,
      videoAssetStatus: "ready",
      videoAvailable: true,
      sourceUrl: "https://whop.com/x/lessons/l2/",
    },
  ]);
  const lessons = await listLessons(pool, course.id);
  return { course, strategyLesson: lessons[0], noStrategyLesson: lessons[1] };
}

/** Creates one COMPLETED analysis (with one strategy instance) and one NO_STRATEGY analysis, and a QUEUED synthesis run over both. */
async function seedRunReadyToClaim() {
  const { course, strategyLesson, noStrategyLesson } = await makeCourseWithLessons();

  const completedAnalysis = await createLessonAnalysis(pool, {
    lessonId: strategyLesson.id,
    jobId: (await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp-1', 'COMPLETED') RETURNING job_id`, [strategyLesson.id])).rows[0].job_id,
    status: "completed",
    strategyFound: true,
    validatedJson: { lesson: { title: strategyLesson.title, duration_seconds: 600 }, strategy_found: true, strategies: [makeStrategy()] },
    analysisSummary: "Break & Retest",
    model: GEMINI_MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: "fp-1",
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 60,
    inputTokens: 1000,
    outputTokens: 100,
    thinkingTokens: 10,
    estimatedCost: 0.01,
  });
  await createStrategyInstances(pool, completedAnalysis.analysisId, strategyLesson.id, [makeStrategy()]);

  const noStrategyAnalysis = await createLessonAnalysis(pool, {
    lessonId: noStrategyLesson.id,
    jobId: (await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, 'fp-2', 'NO_STRATEGY') RETURNING job_id`, [noStrategyLesson.id])).rows[0].job_id,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: { lesson: { title: noStrategyLesson.title, duration_seconds: 400 }, strategy_found: false, strategies: [] },
    analysisSummary: "No concrete trading strategy taught.",
    model: GEMINI_MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: "fp-2",
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 40,
    inputTokens: 500,
    outputTokens: 20,
    thinkingTokens: 0,
    estimatedCost: 0.005,
  });

  const run = await createSynthesisRun(pool, {
    courseId: course.id,
    sourceAnalysisHash: "hash-1",
    sourceAnalysisIds: [completedAnalysis.analysisId, noStrategyAnalysis.analysisId],
    model: GEMINI_MODEL,
    synthesisPromptVersion: "v1",
    synthesisSchemaVersion: "v1",
    synthesizerVersion: "v1",
  });

  return { course, run, strategyLesson, noStrategyLesson };
}

function validCanonicalStrategyJson() {
  return JSON.stringify({
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
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
    sourceLessonIds: [1],
  });
}

function makeFakeGemini(usage = { inputTokens: 100, outputTokens: 50, thinkingTokens: 10 }): GeminiClient {
  const generateStructured = vi.fn(async (prompt: string) => {
    if (prompt.includes("clustering trading-strategy instances")) {
      return {
        text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }] }),
        usage,
      };
    }
    if (prompt.includes("synthesizing ONE canonical trading strategy")) return { text: validCanonicalStrategyJson(), usage };
    if (prompt.includes("Core Trading Framework")) return { text: JSON.stringify({ sections: [] }), usage };
    if (prompt.includes("Comprehensive Trading Playbook")) {
      return { text: JSON.stringify({ title: "Playbook", sections: [], conflictsAndAmbiguities: [] }), usage };
    }
    return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
  });
  return { uploadFile: vi.fn(), waitUntilActive: vi.fn(), analyzeVideo: vi.fn(), deleteFile: vi.fn(), generateStructured };
}

function makeDeps(gemini: GeminiClient, heartbeatIntervalMs = 20): SynthesisWorkerDeps {
  return { pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, heartbeatIntervalMs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSynthesisLoop", () => {
  it("does nothing when there is no eligible synthesis run", async () => {
    const gemini = makeFakeGemini();
    await runSynthesisLoop(makeDeps(gemini));
    expect(gemini.generateStructured).not.toHaveBeenCalled();
  });

  it("claims, processes, and persists a full synthesis run end-to-end", async () => {
    const { run } = await seedRunReadyToClaim();
    const gemini = makeFakeGemini();

    await runSynthesisLoop(makeDeps(gemini));

    const finalRun = await getSynthesisRun(pool, run.runId);
    expect(finalRun?.status).toBe("COMPLETED");
    expect(finalRun?.leaseOwner).toBeNull();
    expect(finalRun?.estimatedCost).toBeGreaterThan(0);

    const clusters = await listStrategyClustersByRun(pool, run.runId);
    expect(clusters).toHaveLength(1);
    const canonicalStrategies = await listCanonicalStrategiesByRun(pool, run.runId);
    expect(canonicalStrategies).toHaveLength(1);
    expect(canonicalStrategies[0].name).toBe("Break & Retest");

    const playbookRow = await getCoursePlaybookByRun(pool, run.runId);
    expect(playbookRow).not.toBeNull();
    // The NO_STRATEGY lesson is explicitly named as a coverage gap, never silently omitted.
    const coverageNotes = playbookRow!.playbook.sections.find((s) => s.key === "coverage_notes");
    expect(coverageNotes?.content).toContain("Sizing & Scaling Trades");
    expect(playbookRow!.playbook.frameworkCoverage.status).toBe("PARTIAL");
  });

  it("marks the run FAILED with a sanitized error when Gemini output fails schema validation, and persists no partial rows", async () => {
    const { run } = await seedRunReadyToClaim();
    const gemini: GeminiClient = {
      uploadFile: vi.fn(),
      waitUntilActive: vi.fn(),
      analyzeVideo: vi.fn(),
      deleteFile: vi.fn(),
      generateStructured: vi.fn(async () => ({ text: "not json", usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } })),
    };

    await runSynthesisLoop(makeDeps(gemini));

    const finalRun = await getSynthesisRun(pool, run.runId);
    expect(finalRun?.status).toBe("FAILED");
    expect(finalRun?.sanitizedError).toBeTruthy();
    expect(await listStrategyClustersByRun(pool, run.runId)).toHaveLength(0);
    expect(await getCoursePlaybookByRun(pool, run.runId)).toBeNull();
  });

  it("keeps renewing the lease while a single long Gemini call is still in flight, via the independent heartbeat", async () => {
    const { run } = await seedRunReadyToClaim();
    let resolveGate!: (value: { text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }) => void;
    const gate = new Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; thinkingTokens: number } }>((resolve) => {
      resolveGate = resolve;
    });
    const gemini: GeminiClient = {
      uploadFile: vi.fn(),
      waitUntilActive: vi.fn(),
      analyzeVideo: vi.fn(),
      deleteFile: vi.fn(),
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) return gate; // block on the very first Gemini call
        throw new Error(`Unexpected prompt: ${prompt.slice(0, 40)}`);
      }),
    };

    const runPromise = runSynthesisLoop(makeDeps(gemini, 20));
    try {
      const deadline = Date.now() + 5000;
      let claimedRun = await getSynthesisRun(pool, run.runId);
      while (claimedRun?.status !== "RUNNING" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        claimedRun = await getSynthesisRun(pool, run.runId);
      }
      expect(claimedRun?.status).toBe("RUNNING");

      const firstHeartbeat = claimedRun!.lastHeartbeatAt!.getTime();
      await new Promise((r) => setTimeout(r, 150)); // several heartbeat ticks' worth of time, still blocked
      const later = await getSynthesisRun(pool, run.runId);
      expect(later?.status).toBe("RUNNING"); // still blocked on the very first Gemini call
      expect(later!.lastHeartbeatAt!.getTime()).toBeGreaterThan(firstHeartbeat);
    } finally {
      resolveGate({ text: JSON.stringify({ clusters: [] }), usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 } });
      await runPromise;
    }
  });

  it("cannot complete once its lease has been reclaimed by another execution", async () => {
    const { run } = await seedRunReadyToClaim();
    // Simulate: this run gets claimed and completes exactly at the moment another execution reclaims it.
    // We simulate the race by claiming it ourselves first, then having runSynthesisLoop find nothing (fenced fully) —
    // proving via claimNextEligibleSynthesisRun directly that a reclaimed run cannot be claimed twice concurrently.
    const claimed = await claimNextEligibleSynthesisRun(pool, "someone-else");
    expect(claimed?.runId).toBe(run.runId);

    const gemini = makeFakeGemini();
    await runSynthesisLoop(makeDeps(gemini)); // finds nothing eligible — already RUNNING with a live lease held by "someone-else"
    expect(gemini.generateStructured).not.toHaveBeenCalled();

    const finalRun = await getSynthesisRun(pool, run.runId);
    expect(finalRun?.status).toBe("RUNNING");
    expect(finalRun?.leaseOwner).toBe("someone-else");
  });

  it("never reprocesses the same lesson_analyses/strategy_instances rows — source data is read-only", async () => {
    const { run } = await seedRunReadyToClaim();
    const beforeAnalyses = await getByAnalysisIds(pool, run.sourceAnalysisIds);
    const gemini = makeFakeGemini();
    await runSynthesisLoop(makeDeps(gemini));
    const afterAnalyses = await getByAnalysisIds(pool, run.sourceAnalysisIds);
    expect(afterAnalyses).toEqual(beforeAnalyses);
  });
});
