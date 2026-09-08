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
import { createSynthesisStatusHandler, createGetSynthesisHandler } from "../src/http/routes/courseSynthesis.js";
import {
  createProjectSynthesisStatusHandler,
  createProjectSynthesizeHandler,
  createGetProjectSynthesisHandler,
} from "../src/http/routes/projectSynthesis.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import type { Strategy } from "../src/gemini/schema.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { computeAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
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
  // Deliberately never truncates `projects` — matches
  // projectSourcesRoutes.test.ts's existing convention: each test creates
  // its own project(s) via randomId()-named rows and only ever asserts on
  // those, so accumulated rows from other tests/files sharing this DB are
  // harmless. Truncating it here would risk wiping rows another test file
  // is concurrently asserting on.
});

interface TestProject {
  id: number;
  name: string;
}

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<TestProject> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [name, projectType]);
  return { id: Number(result.rows[0].id), name };
}

async function makeCourse(projectId?: number, overrides: { title?: string; whopCourseId?: string } = {}) {
  const course = await upsertCourse(pool, {
    whopCourseId: overrides.whopCourseId ?? randomId("cors"),
    whopExperienceId: "exp_gdmood6JIzSsE7",
    slug: "scarface-trades-mastermind",
    title: overrides.title ?? "Scarface Trades Mastermind",
  });
  if (projectId !== undefined) {
    await pool.query(`UPDATE courses SET project_id = $1 WHERE id = $2`, [projectId, course.id]);
  }
  return course;
}

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

/** Mirrors courseSynthesisRoutes.test.ts's helper of the same name — a synced, analyzed lesson whose analysis is CURRENT (preflight-ready) by default. */
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
    await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, $3) RETURNING job_id`, [
      lesson.id,
      randomId("fp"),
      opts.strategyFound ? "COMPLETED" : "NO_STRATEGY",
    ])
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
    analysisFingerprint: computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: GEMINI_MODEL }),
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

/** Deliberately omits any Whop client, oauthClient, or auth_sessions row — proves K/L (no Whop connection required) simply by having nothing Whop-related to mock. */
function projectDeps(jobTrigger = makeJobTrigger()) {
  return { pool, geminiModel: GEMINI_MODEL, jobTrigger };
}

async function callStatus(projectId: string) {
  const handler = createProjectSynthesisStatusHandler(projectDeps());
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as Record<string, unknown> };
}

async function callGetSynthesis(projectId: string) {
  const handler = createGetProjectSynthesisHandler(projectDeps());
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as Record<string, unknown> };
}

async function callSynthesize(projectId: string, opts: { force?: boolean; jobTrigger?: JobTrigger } = {}) {
  const jobTrigger = opts.jobTrigger ?? makeJobTrigger();
  const handler = createProjectSynthesizeHandler(projectDeps(jobTrigger));
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId }, body: { force: opts.force === true } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as Record<string, unknown>, jobTrigger };
}

/** Completes a run end to end via the real worker-claim path, exactly like courseSynthesisRoutes.test.ts. */
async function completeARun(runId: string) {
  const claimed = await claimNextEligibleSynthesisRun(pool, "owner-a");
  expect(claimed?.runId).toBe(runId);
  await markSynthesisCompleted(pool, runId, "owner-a", {
    inputTokens: 1,
    outputTokens: 1,
    thinkingTokens: 0,
    estimatedCost: 0.01,
    processingDurationSeconds: 5,
  });
}

describe("GET /api/projects/:projectId/synthesis/status", () => {
  it("A: an authenticated request for a real, analyzed project succeeds", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const { statusCode, body } = await callStatus(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.projectId).toBe(project.id);
    expect(body.status).toBe("ready");
    expect(body.canSynthesizeNow).toBe(true);
  });

  it("B: resolves MasterMind's attached course via project ownership, not a global course id", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id, { title: "The Trading Accelerator" });
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const { body } = await callStatus(String(project.id));
    expect(body.sourceCourseId).toBe(course.id);
    expect(body.sourceName).toBe("The Trading Accelerator");
    expect((body.course as { title: string }).title).toBe("The Trading Accelerator");
  });

  it("E: an unknown project returns a deterministic 404", async () => {
    const { statusCode, body } = await callStatus("999999999");
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_not_found");
  });

  it("E: a non-numeric projectId returns 404 rather than 500ing", async () => {
    const { statusCode, body } = await callStatus("mastermind");
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_not_found");
  });

  it("F: a known project with zero sources reports a clean empty state — no fabricated course, no fallback to any other course", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callStatus(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("no_source");
    expect(body.sourceCount).toBe(0);
    expect(body.course).toBeNull();
    expect(body.canSynthesizeNow).toBe(false);
  });

  it("G: a GENERAL_KNOWLEDGE project reports unsupported_project_type rather than invoking trading-strategies synthesis", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { statusCode, body } = await callStatus(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("unsupported_project_type");
    expect(body.canSynthesizeNow).toBe(false);
  });

  it("H: a project with more than one course reports multiple_sources rather than silently choosing one", async () => {
    const project = await makeProject();
    await makeCourse(project.id, { title: "Course One" });
    await makeCourse(project.id, { title: "Course Two" });

    const { statusCode, body } = await callStatus(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("multiple_sources");
    expect(body.sourceCount).toBe(2);
    expect(body.sourceCourseId).toBeNull();
  });

  it("D: project A's status never reflects project B's course/data", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = await makeCourse(projectA.id, { title: "Project A Course" });
    await makeCourse(projectB.id, { title: "Project B Course" });
    await addAnalyzedLesson(courseA.id, { strategyFound: true });

    const { body: bodyA } = await callStatus(String(projectA.id));
    const { body: bodyB } = await callStatus(String(projectB.id));

    expect(bodyA.sourceName).toBe("Project A Course");
    expect(bodyA.canSynthesizeNow).toBe(true);
    expect(bodyB.sourceName).toBe("Project B Course");
    expect(bodyB.canSynthesizeNow).toBe(false); // Project B's course has no analyzed lessons
  });

  it("K: no Whop connection state is consulted for a persisted-status read (no auth_sessions row, no Whop client dependency at all)", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    // No auth_sessions row exists for this deployment at all — a live Whop
    // connection genuinely does not exist — yet the read still succeeds.
    const { statusCode, body } = await callStatus(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ready");
  });
});

describe("POST /api/projects/:projectId/synthesis", () => {
  it("I: resolves the project's own course rather than any globally configured course — creates a QUEUED run scoped to the right course_id", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const { statusCode, body, jobTrigger } = await callSynthesize(String(project.id));
    expect(statusCode).toBe(202);
    const run = body.run as { runId: string; status: string };
    expect(run.status).toBe("QUEUED");
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

    const dbRow = await pool.query<{ course_id: string }>(`SELECT course_id FROM synthesis_runs WHERE run_id = $1`, [run.runId]);
    expect(Number(dbRow.rows[0].course_id)).toBe(course.id);
  });

  it("J: re-synthesize (force) resolves the same project ownership and creates a new run for the same course", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const first = await callSynthesize(String(project.id));
    const firstRun = first.body.run as { runId: string };
    await completeARun(firstRun.runId);

    const second = await callSynthesize(String(project.id), { force: true });
    expect(second.statusCode).toBe(202);
    const secondRun = second.body.run as { runId: string };
    expect(secondRun.runId).not.toBe(firstRun.runId);

    const dbRow = await pool.query<{ course_id: string }>(`SELECT course_id FROM synthesis_runs WHERE run_id = $1`, [secondRun.runId]);
    expect(Number(dbRow.rows[0].course_id)).toBe(course.id);
  });

  it("E: POST for an unknown project returns a deterministic 404", async () => {
    const { statusCode, body } = await callSynthesize("999999999");
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_not_found");
  });

  it("F: POST for a project with zero sources is refused deterministically — Synthesize is unavailable, not silently redirected", async () => {
    const project = await makeProject();
    const { statusCode, body, jobTrigger } = await callSynthesize(String(project.id));
    expect(statusCode).toBe(409);
    expect((body.error as { type: string }).type).toBe("no_source");
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("G: POST for a GENERAL_KNOWLEDGE project cannot invoke trading-strategies synthesis", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { statusCode, body, jobTrigger } = await callSynthesize(String(project.id));
    expect(statusCode).toBe(409);
    expect((body.error as { type: string }).type).toBe("unsupported_project_type");
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("H: POST for a project with multiple courses is refused rather than silently choosing one", async () => {
    const project = await makeProject();
    await makeCourse(project.id, { title: "Course One" });
    await makeCourse(project.id, { title: "Course Two" });

    const { statusCode, body, jobTrigger } = await callSynthesize(String(project.id));
    expect(statusCode).toBe(409);
    expect((body.error as { type: string }).type).toBe("multiple_sources");
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("L: no Whop connection is required to run synthesis against sufficient persisted analyses (no auth_sessions row exists in this test at all)", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const { statusCode, body } = await callSynthesize(String(project.id));
    expect(statusCode).toBe(202);
    expect((body.run as { status: string }).status).toBe("QUEUED");
  });

  it("D: project A cannot trigger synthesis against project B's course", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = await makeCourse(projectA.id);
    const courseB = await makeCourse(projectB.id);
    await addAnalyzedLesson(courseA.id, { strategyFound: true });

    const { statusCode, body } = await callSynthesize(String(projectA.id));
    expect(statusCode).toBe(202);
    const run = body.run as { runId: string };
    const dbRow = await pool.query<{ course_id: string }>(`SELECT course_id FROM synthesis_runs WHERE run_id = $1`, [run.runId]);
    expect(Number(dbRow.rows[0].course_id)).toBe(courseA.id);
    expect(Number(dbRow.rows[0].course_id)).not.toBe(courseB.id);
  });
});

describe("GET /api/projects/:projectId/synthesis", () => {
  async function seedCompletedSynthesis(projectId: number, courseTitle = "Scarface Trades Mastermind") {
    const course = await makeCourse(projectId, { title: courseTitle });
    await addAnalyzedLesson(course.id, { strategyFound: true });

    const created = await callSynthesize(String(projectId));
    const runId = (created.body.run as { runId: string }).runId;

    const clusterRow = await createStrategyCluster(pool, runId, {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1],
      similarityRationale: "r",
      differencesNotes: "",
    });
    await createCanonicalStrategy(pool, runId, clusterRow.clusterId, {
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
      runId,
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
        universalApplicabilityLeaks: [],
        unverifiedUniversalClaims: [],
        scopedApplicabilityLeaks: [],
      },
      decisionFramework: { nodes: [], readableSteps: [], scopeLeaks: [] },
    });
    await completeARun(runId);
    return { course, runId };
  }

  it("C: an existing completed synthesis is returned through the project route with its clusters/canonical strategies/playbook", async () => {
    const project = await makeProject();
    const { runId } = await seedCompletedSynthesis(project.id);

    const { statusCode, body } = await callGetSynthesis(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ready");
    const run = body.run as { runId: string };
    expect(run.runId).toBe(runId);
    const clusters = body.clusters as { canonicalName: string }[];
    expect(clusters[0].canonicalName).toBe("Break & Retest");
    const canonicalStrategies = body.canonicalStrategies as { name: string }[];
    expect(canonicalStrategies[0].name).toBe("Break & Retest");
  });

  it("E: an unknown project returns a deterministic 404", async () => {
    const { statusCode, body } = await callGetSynthesis("999999999");
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_not_found");
  });

  it("F: a known project with zero sources returns run: null, never MasterMind's or any other synthesis", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callGetSynthesis(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("no_source");
    expect(body.run).toBeNull();
  });

  it("G: a GENERAL_KNOWLEDGE project's synthesis read reports unsupported_project_type, never fabricated results", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { statusCode, body } = await callGetSynthesis(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("unsupported_project_type");
    expect(body.run).toBeNull();
  });

  it("D: project A cannot read project B's synthesis", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await seedCompletedSynthesis(projectA.id, "Project A's Course");
    // Project B has its own course with no synthesis at all.
    await makeCourse(projectB.id, { title: "Project B's Course" });

    const { body: bodyA } = await callGetSynthesis(String(projectA.id));
    const { body: bodyB } = await callGetSynthesis(String(projectB.id));

    expect((bodyA.run as { runId: string } | null)?.runId).toBeTruthy();
    expect(bodyB.run).toBeNull();
    expect(bodyB.sourceName).toBe("Project B's Course");
  });

  it("K: reading existing synthesis through the project route requires no Whop connection state (no auth_sessions row exists in this test)", async () => {
    const project = await makeProject();
    await seedCompletedSynthesis(project.id);

    const { statusCode, body } = await callGetSynthesis(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.status).toBe("ready");
  });

  it("M: reading through the project endpoint repeatedly never duplicates or mutates synthesis_runs", async () => {
    const project = await makeProject();
    await seedCompletedSynthesis(project.id);

    const countRuns = async () => Number((await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM synthesis_runs`)).rows[0].count);
    const before = await countRuns();

    await callGetSynthesis(String(project.id));
    await callGetSynthesis(String(project.id));
    await callStatus(String(project.id));

    expect(await countRuns()).toBe(before);
  });

  it("N: MasterMind's existing persisted synthesis is returned unchanged through the project route — same runId, same course_id, same canonical strategy content — as reading it through the legacy course route", async () => {
    // Simulates "MasterMind already has a valid production synthesis" —
    // seeded via the project route, but this test's whole point is that
    // BOTH the legacy config.course.courseId-based route AND the new
    // project-scoped route resolve to the exact same underlying data, with
    // neither route regenerating, migrating, or duplicating anything.
    const project = await makeProject();
    const { course, runId } = await seedCompletedSynthesis(project.id, "MasterMind's Course");

    const legacyDeps = { pool, whopCourseId: course.whopCourseId, geminiModel: GEMINI_MODEL, jobTrigger: makeJobTrigger() };
    const legacyHandler = createGetSynthesisHandler(legacyDeps);
    const legacyResult = makeResponse();
    await legacyHandler({} as Request, legacyResult.res);
    const legacyBody = legacyResult.body() as { run: { runId: string }; canonicalStrategies: { name: string }[] };

    const { body: projectBody } = await callGetSynthesis(String(project.id));
    const projectRun = projectBody.run as { runId: string };
    const projectCanonicalStrategies = projectBody.canonicalStrategies as { name: string }[];

    expect(projectRun.runId).toBe(runId);
    expect(legacyBody.run.runId).toBe(runId);
    expect(projectRun.runId).toBe(legacyBody.run.runId);
    expect(projectCanonicalStrategies[0].name).toBe(legacyBody.canonicalStrategies[0].name);

    // Also prove the legacy status route (still keyed by config.course.courseId) is untouched/still functional.
    const legacyStatusHandler = createSynthesisStatusHandler(legacyDeps);
    const legacyStatusResult = makeResponse();
    await legacyStatusHandler({} as Request, legacyStatusResult.res);
    const legacyStatusBody = legacyStatusResult.body() as { latestCompletedRun: { runId: string } };
    expect(legacyStatusBody.latestCompletedRun.runId).toBe(runId);
  });
});
