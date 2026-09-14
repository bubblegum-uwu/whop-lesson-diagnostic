import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { createSynthesisRun, markSynthesisCompleted, markSynthesisFailed, getSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { createCoursePlaybook } from "../src/db/coursePlaybooksRepo.js";
import { createWhopLessonImport } from "../src/db/whopLessonImportsRepo.js";
import {
  createCreateSynthesisSetHandler,
  createGetSynthesisSetHandler,
  createAddSourceToSynthesisSetHandler,
  createAddLessonToSynthesisSetHandler,
  createRemoveLessonFromSynthesisSetHandler,
  createBulkUpdateSynthesisSetLessonsHandler,
  createBulkAddCourseToSynthesisSetHandler,
  createBulkRemoveCourseFromSynthesisSetHandler,
  createListLegacySynthesisRunsHandler,
  createGetLegacySynthesisPlaybookHandler,
  type SynthesisSetsRouteDeps,
} from "../src/http/routes/synthesisSets.js";
import { planLegacyWhopSynthesisRecovery, applyLegacyWhopSynthesisRecovery, RecoveryStopError } from "../src/whop/legacySynthesisRecovery.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

function deps(): SynthesisSetsRouteDeps {
  return { pool };
}

async function makeProject(type: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<{ id: number; name: string }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [name, type]);
  return { id: Number(result.rows[0].id), name };
}

async function makeCourse(projectId: number | null): Promise<{ id: number; whopCourseId: string; title: string }> {
  const whopCourseId = randomId("cors");
  const course = await upsertCourse(pool, { whopCourseId, whopExperienceId: "exp_1", slug: "trading-accelerator", title: "The Trading Accelerator" });
  if (projectId !== null) {
    await pool.query(`UPDATE courses SET project_id = $1 WHERE id = $2`, [projectId, course.id]);
  }
  return { id: course.id, whopCourseId, title: course.title };
}

async function makeLesson(courseId: number, title = "Lesson"): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', 'https://whop.com/x') RETURNING id`,
    [courseId, randomId("lesn"), title],
  );
  return { id: Number(result.rows[0].id) };
}

/** Inserts a completed/no_strategy lesson_analyses row (the exact eligibility rule this bridge reuses — see whopLessonAnalysisStatusRepo.ts) — mirrors the codebase's own fixture pattern in courseSynthesisRoutes.test.ts. */
async function analyzeLesson(lessonId: number, status: "completed" | "no_strategy" = "completed"): Promise<number> {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, $3) RETURNING job_id`,
    [lessonId, randomId("fp"), status === "completed" ? "COMPLETED" : "NO_STRATEGY"],
  );
  const analysis = await createLessonAnalysis(pool, {
    lessonId,
    jobId: jobResult.rows[0].job_id,
    status,
    strategyFound: status === "completed",
    validatedJson: { lesson: { title: "t", duration_seconds: 600 }, strategy_found: status === "completed", strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "Summary.",
    model: GEMINI_MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 10,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
  return analysis.analysisId;
}

async function makeYouTubeSourceAnalyzed(projectId: number): Promise<{ id: number }> {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=x" });
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [source.id, randomId("fp")],
  );
  await createProjectSourceAnalysis(pool, {
    projectSourceId: source.id,
    jobId: jobResult.rows[0].job_id,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "No strategy found.",
    model: GEMINI_MODEL,
    promptVersion: "v2",
    extractorVersion: "v2",
    schemaVersion: "v2",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 10,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
  return { id: source.id };
}

/**
 * Creates and terminates (COMPLETED or FAILED) a real synthesis_runs row.
 * Deliberately does NOT use claimNextEligibleSynthesisRun here — that
 * query claims whichever due row is globally oldest across the ENTIRE
 * table (by design, for the real worker's claim loop), which in this
 * shared, never-truncated test database can pick up an unrelated leftover
 * row from a different test file instead of the one THIS call just
 * created. Fixture setup needs to terminate the SPECIFIC run it made, so
 * this claims it directly by run_id instead.
 */
async function makeTerminalRun(courseId: number, opts: { sourceAnalysisIds: number[]; terminal: "COMPLETED" | "FAILED" }): Promise<string> {
  const run = await createSynthesisRun(pool, {
    courseId,
    sourceAnalysisHash: randomId("hash"),
    sourceAnalysisIds: opts.sourceAnalysisIds,
    model: GEMINI_MODEL,
    synthesisPromptVersion: "v1",
    synthesisSchemaVersion: "v1",
    synthesizerVersion: "v1",
  });
  const leaseOwner = randomId("owner");
  await pool.query(`UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = $2 WHERE run_id = $1`, [run.runId, leaseOwner]);
  if (opts.terminal === "COMPLETED") {
    await markSynthesisCompleted(pool, run.runId, leaseOwner, { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, estimatedCost: 0.001, processingDurationSeconds: 5 });
  } else {
    await markSynthesisFailed(pool, run.runId, leaseOwner, "gemini_error", "Synthesis failed.", 5);
  }
  return run.runId;
}

async function makePlaybook(runId: string) {
  return createCoursePlaybook(pool, {
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
}

function callCreateSet(projectId: number, name: string) {
  const handler = createCreateSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId) }, body: { name } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGetSet(projectId: number, setId: number) {
  const handler = createGetSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAddSource(projectId: number, setId: number, sourceId: number) {
  const handler = createAddSourceToSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { sourceId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAddLesson(projectId: number, setId: number, lessonId: number) {
  const handler = createAddLessonToSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { lessonId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRemoveLesson(projectId: number, setId: number, lessonId: number) {
  const handler = createRemoveLessonFromSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), lessonId: String(lessonId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkLessons(projectId: number, setId: number, bulkBody: { add?: number[]; remove?: number[] }) {
  const handler = createBulkUpdateSynthesisSetLessonsHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: bulkBody } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkAddCourse(projectId: number, setId: number, courseId: number) {
  const handler = createBulkAddCourseToSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), courseId: String(courseId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkRemoveCourse(projectId: number, setId: number, courseId: number) {
  const handler = createBulkRemoveCourseFromSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), courseId: String(courseId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callListLegacyRuns(projectId: number, setId: number) {
  const handler = createListLegacySynthesisRunsHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGetPlaybook(projectId: number, setId: number, runId: string) {
  const handler = createGetLegacySynthesisPlaybookHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), runId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("Pre-4M Whop synthesis set bridge — lesson membership (scenarios 1-10)", () => {
  it("1: synthesis_set_lessons FK/membership — adding a lesson creates real membership readable back via GET", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const addResult = await callAddLesson(project.id, set.id as number, lesson.id);
    expect(addResult.statusCode).toBe(201);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toEqual([expect.objectContaining({ kind: "WHOP_LESSON", id: lesson.id, analyzed: true })]);
  });

  it("2: a lesson belonging to a DIFFERENT project is rejected by application validation", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseB = await makeCourse(projectB.id);
    const lessonB = await makeLesson(courseB.id);
    await analyzeLesson(lessonB.id);
    const { body: setA } = await callCreateSet(projectA.id, "Strategies");

    const result = await callAddLesson(projectA.id, setA.id as number, lessonB.id);
    expect(result.statusCode).toBe(404);
    expect((result.body.error as { type: string }).type).toBe("lesson_not_found");
  });

  it("3: a course-owned (fully connected) lesson is accepted", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const result = await callAddLesson(project.id, set.id as number, lesson.id);
    expect(result.statusCode).toBe(201);
  });

  it("4: an à-la-carte-imported Whop lesson (course NOT connected to this project) is accepted via project_whop_lesson_imports", async () => {
    const project = await makeProject();
    const course = await makeCourse(null); // course deliberately unconnected
    const lesson = await makeLesson(course.id);
    await analyzeLesson(lesson.id);
    await createWhopLessonImport(pool, project.id, lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const result = await callAddLesson(project.id, set.id as number, lesson.id);
    expect(result.statusCode).toBe(201);
  });

  it("5: set counts include BOTH synthesis_set_sources and synthesis_set_lessons", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson1 = await makeLesson(course.id);
    const lesson2 = await makeLesson(course.id);
    await analyzeLesson(lesson1.id);
    await analyzeLesson(lesson2.id);
    const source = await makeYouTubeSourceAnalyzed(project.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    await callAddSource(project.id, set.id as number, source.id);
    await callAddLesson(project.id, set.id as number, lesson1.id);
    await callAddLesson(project.id, set.id as number, lesson2.id);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.sourceCount).toBe(3);
    expect(detail.analyzedSourceCount).toBe(3);
    expect(detail.needsAnalysisCount).toBe(0);
  });

  it("6: the Fine-Tune read endpoint (GET set detail) includes Whop lessons as a distinctly-shaped array", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id, "Break & Retest Setup");
    await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddLesson(project.id, set.id as number, lesson.id);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toHaveLength(1);
    const lessonRow = (detail.lessons as Record<string, unknown>[])[0];
    expect(lessonRow.kind).toBe("WHOP_LESSON");
    expect(lessonRow.title).toBe("Break & Retest Setup");
    expect(lessonRow.courseId).toBe(course.id);
    expect(detail.sources).toEqual([]);
  });

  it("7: bulk Whop Course snapshot adds every CURRENTLY eligible lesson", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const eligible1 = await makeLesson(course.id);
    const eligible2 = await makeLesson(course.id);
    const ineligible = await makeLesson(course.id);
    await analyzeLesson(eligible1.id);
    await analyzeLesson(eligible2.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const result = await callBulkAddCourse(project.id, set.id as number, course.id);
    expect(result.statusCode).toBe(200);
    expect(result.body.eligibleCount).toBe(2);
    expect(result.body.addedCount).toBe(2);
    expect(result.body.ineligibleCount).toBe(1);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    const lessonIds = (detail.lessons as { id: number }[]).map((l) => l.id).sort();
    expect(lessonIds).toEqual([eligible1.id, eligible2.id].sort((a, b) => a - b));
    void ineligible;
  });

  it("8: repeated bulk Whop Course snapshot add is idempotent — second call adds nothing new", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const first = await callBulkAddCourse(project.id, set.id as number, course.id);
    expect(first.body.addedCount).toBe(1);
    const second = await callBulkAddCourse(project.id, set.id as number, course.id);
    expect(second.body.addedCount).toBe(0);
    expect(second.body.alreadySelectedCount).toBe(1);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toHaveLength(1);
  });

  it("9: a lesson added to the course AFTER a bulk snapshot never auto-enters the set (snapshot semantics)", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson1 = await makeLesson(course.id);
    await analyzeLesson(lesson1.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callBulkAddCourse(project.id, set.id as number, course.id);

    // A new lesson, analyzed AFTER the snapshot.
    const lesson2 = await makeLesson(course.id);
    await analyzeLesson(lesson2.id);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toHaveLength(1);
    expect((detail.lessons as { id: number }[])[0].id).toBe(lesson1.id);
  });

  it("10: removing one lesson from a fully-selected course leaves the set with exactly the remaining lessons (tri-state basis)", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson1 = await makeLesson(course.id);
    const lesson2 = await makeLesson(course.id);
    await analyzeLesson(lesson1.id);
    await analyzeLesson(lesson2.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callBulkAddCourse(project.id, set.id as number, course.id);

    const removeResult = await callRemoveLesson(project.id, set.id as number, lesson1.id);
    expect(removeResult.statusCode).toBe(204);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toHaveLength(1);
    expect((detail.lessons as { id: number }[])[0].id).toBe(lesson2.id);
    expect(detail.sourceCount).toBe(1);
  });

  it("bulk lessons/bulk endpoint: 'select all visible eligible' adds only eligible ids, skips ineligible/foreign ones", async () => {
    const project = await makeProject();
    const other = await makeProject();
    const course = await makeCourse(project.id);
    const otherCourse = await makeCourse(other.id);
    const eligible = await makeLesson(course.id);
    const ineligible = await makeLesson(course.id);
    const foreign = await makeLesson(otherCourse.id);
    await analyzeLesson(eligible.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const result = await callBulkLessons(project.id, set.id as number, { add: [eligible.id, ineligible.id, foreign.id] });
    expect(result.body.addedCount).toBe(1);
    expect(result.body.ineligibleSkippedCount).toBe(2);

    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect((detail.lessons as { id: number }[]).map((l) => l.id)).toEqual([eligible.id]);
  });

  it("removing a whole course via bulk-remove only removes THIS set's lessons for that course", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson1 = await makeLesson(course.id);
    const lesson2 = await makeLesson(course.id);
    await analyzeLesson(lesson1.id);
    await analyzeLesson(lesson2.id);
    const { body: setA } = await callCreateSet(project.id, "Set A");
    const { body: setB } = await callCreateSet(project.id, "Set B");
    await callBulkAddCourse(project.id, setA.id as number, course.id);
    await callBulkAddCourse(project.id, setB.id as number, course.id);

    const result = await callBulkRemoveCourse(project.id, setA.id as number, course.id);
    expect(result.body.removedCount).toBe(2);

    const { body: detailA } = await callGetSet(project.id, setA.id as number);
    expect(detailA.lessons).toEqual([]);
    const { body: detailB } = await callGetSet(project.id, setB.id as number);
    expect(detailB.lessons).toHaveLength(2);
  });
});

describe("Pre-4M Whop synthesis set bridge — legacy run history (scenarios 11-14)", () => {
  it("11: legacy run attachment surfaces ALL attached runs, not just the latest", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const runA = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(runA);
    const runB = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "FAILED" });
    const runC = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(runC);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });

    const { statusCode, body } = await callListLegacyRuns(project.id, set.id as number);
    expect(statusCode).toBe(200);
    const runIds = (body.runs as { runId: string }[]).map((r) => r.runId).sort();
    expect(runIds).toEqual([runA, runB, runC].sort());
  });

  it("12: failed run history is preserved, never discarded", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const completedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(completedRun);
    const failedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "FAILED" });
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });

    const { body } = await callListLegacyRuns(project.id, set.id as number);
    const runs = body.runs as { runId: string; status: string; errorType: string | null; sanitizedError: string | null }[];
    const failed = runs.find((r) => r.runId === failedRun)!;
    expect(failed.status).toBe("FAILED");
    expect(failed.errorType).toBe("gemini_error");
    expect(failed.sanitizedError).toBe("Synthesis failed.");
  });

  it("13: a completed run returns its existing course_playbooks content unchanged", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const runId = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    const playbook = await makePlaybook(runId);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });

    const { statusCode, body } = await callGetPlaybook(project.id, set.id as number, runId);
    expect(statusCode).toBe(200);
    expect(body.title).toBe(playbook.title);
    expect(body.coreFramework).toEqual(playbook.coreFramework);
    expect(body.playbook).toEqual(playbook.playbook);
    expect(body.decisionFramework).toEqual(playbook.decisionFramework);
  });

  it("14: the historical run's source_analysis_ids are unchanged by attachment or by reading it back", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const runId = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(runId);
    const before = await getSynthesisRun(pool, runId);

    const { body: set } = await callCreateSet(project.id, "Strategies");
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    void set;

    const after = await getSynthesisRun(pool, runId);
    expect(after!.sourceAnalysisIds).toEqual(before!.sourceAnalysisIds);
    expect(after!.sourceAnalysisIds).toEqual([analysisId]);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });

  it("a FAILED run has no playbook — the playbook endpoint 404s rather than fabricating one", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const completedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(completedRun);
    const failedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "FAILED" });
    const { body: set } = await callCreateSet(project.id, "Strategies");
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });

    const { statusCode } = await callGetPlaybook(project.id, set.id as number, failedRun);
    expect(statusCode).toBe(404);
  });
});

describe("Pre-4M legacy Whop synthesis recovery script (scenarios 15-21)", () => {
  async function seedRecoverableCourse(lessonCount: number) {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lessons = await Promise.all(Array.from({ length: lessonCount }, () => makeLesson(course.id)));
    const analysisIds = await Promise.all(lessons.map((l) => analyzeLesson(l.id)));
    const completedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: analysisIds, terminal: "COMPLETED" });
    await makePlaybook(completedRun);
    const failedRun = await makeTerminalRun(course.id, { sourceAnalysisIds: analysisIds.slice(0, 1), terminal: "FAILED" });
    return { project, course, lessons, analysisIds, completedRun, failedRun };
  }

  it("15: dry-run (plan only) writes nothing", async () => {
    const { project, course } = await seedRecoverableCourse(3);
    const countsBefore = await pool.query(`SELECT (SELECT COUNT(*) FROM synthesis_sets) AS sets, (SELECT COUNT(*) FROM synthesis_set_lessons) AS lessons, (SELECT COUNT(*) FROM synthesis_set_legacy_runs) AS runs`);

    await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });

    const countsAfter = await pool.query(`SELECT (SELECT COUNT(*) FROM synthesis_sets) AS sets, (SELECT COUNT(*) FROM synthesis_set_lessons) AS lessons, (SELECT COUNT(*) FROM synthesis_set_legacy_runs) AS runs`);
    expect(countsAfter.rows[0]).toEqual(countsBefore.rows[0]);
  });

  it("16: apply creates the target Synthesis Set when it doesn't already exist", async () => {
    const { project, course } = await seedRecoverableCourse(3);
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(plan.existingSet).toBeNull();

    const result = await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(result.createdSet).toBe(true);

    const { body: detail } = await callGetSet(project.id, result.synthesisSetId);
    expect(detail.name).toBe("Strategies");
  });

  it("17: apply attaches exactly the distinct lessons referenced by the latest completed run's source_analysis_ids", async () => {
    const { project, course, lessons } = await seedRecoverableCourse(5);
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(plan.distinctLessonIds.length).toBe(5);

    const result = await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(result.lessonsAttached).toBe(5);

    const { body: detail } = await callGetSet(project.id, result.synthesisSetId);
    expect((detail.lessons as { id: number }[]).map((l) => l.id).sort((a, b) => a - b)).toEqual(lessons.map((l) => l.id).sort((a, b) => a - b));
  });

  it("18: apply attaches exactly every historical synthesis_runs row for the course (completed and failed)", async () => {
    const { project, course, completedRun, failedRun } = await seedRecoverableCourse(3);
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(plan.allRuns.length).toBe(2);

    const result = await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    expect(result.runsAttached).toBe(2);

    const { body } = await callListLegacyRuns(project.id, result.synthesisSetId);
    const runIds = (body.runs as { runId: string }[]).map((r) => r.runId).sort();
    expect(runIds).toEqual([completedRun, failedRun].sort());
  });

  it("19: applying twice is idempotent — second apply attaches zero new lessons/runs and creates no new set", async () => {
    const { project, course } = await seedRecoverableCourse(4);
    const args = { projectName: project.name, projectType: "TRADING_STRATEGIES" as const, courseWhopId: course.whopCourseId, setName: "Strategies" };

    const plan1 = await planLegacyWhopSynthesisRecovery(pool, args);
    const result1 = await applyLegacyWhopSynthesisRecovery(pool, plan1, args);
    expect(result1.createdSet).toBe(true);
    expect(result1.lessonsAttached).toBe(4);
    expect(result1.runsAttached).toBe(2);

    const plan2 = await planLegacyWhopSynthesisRecovery(pool, args);
    expect(plan2.existingSet).not.toBeNull();
    expect(plan2.newLessonCount).toBe(0);
    expect(plan2.newRunCount).toBe(0);
    const result2 = await applyLegacyWhopSynthesisRecovery(pool, plan2, args);
    expect(result2.createdSet).toBe(false);
    expect(result2.synthesisSetId).toBe(result1.synthesisSetId);
    expect(result2.lessonsAttached).toBe(0);
    expect(result2.runsAttached).toBe(0);

    const { body: detail } = await callGetSet(project.id, result2.synthesisSetId);
    expect(detail.lessons).toHaveLength(4);
    const { body: runsBody } = await callListLegacyRuns(project.id, result2.synthesisSetId);
    expect(runsBody.runs).toHaveLength(2);
  });

  it("20: recovery (plan + apply) starts zero analysis_jobs rows", async () => {
    const { project, course } = await seedRecoverableCourse(3);
    const before = await pool.query(`SELECT COUNT(*) AS n FROM analysis_jobs`);
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    const after = await pool.query(`SELECT COUNT(*) AS n FROM analysis_jobs`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("21: recovery (plan + apply) starts zero synthesis_runs rows — attaches only pre-existing ones", async () => {
    const { project, course } = await seedRecoverableCourse(3);
    const before = await pool.query(`SELECT COUNT(*) AS n FROM synthesis_runs`);
    const plan = await planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    await applyLegacyWhopSynthesisRecovery(pool, plan, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" });
    const after = await pool.query(`SELECT COUNT(*) AS n FROM synthesis_runs`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("STOP: an unconnected course (courses.project_id does not match) refuses recovery, writes nothing", async () => {
    const project = await makeProject();
    const course = await makeCourse(null);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    const runId = await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" });
    await makePlaybook(runId);

    await expect(
      planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" }),
    ).rejects.toBeInstanceOf(RecoveryStopError);
  });

  it("STOP: no completed run for the course refuses recovery", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "FAILED" });

    await expect(
      planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" }),
    ).rejects.toThrow(/No COMPLETED synthesis run/);
  });

  it("STOP: a completed run with no course_playbooks row refuses recovery", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const analysisId = await analyzeLesson(lesson.id);
    await makeTerminalRun(course.id, { sourceAnalysisIds: [analysisId], terminal: "COMPLETED" }); // no makePlaybook call

    await expect(
      planLegacyWhopSynthesisRecovery(pool, { projectName: project.name, projectType: "TRADING_STRATEGIES", courseWhopId: course.whopCourseId, setName: "Strategies" }),
    ).rejects.toThrow(/No course_playbooks row/);
  });
});

describe("Pre-4M — no regression to existing synthesis-set behavior (sanity)", () => {
  it("a set with zero lessons still reports lessons: [] rather than omitting the field", async () => {
    const project = await makeProject();
    const { body: set } = await callCreateSet(project.id, "Strategies");
    const { body: detail } = await callGetSet(project.id, set.id as number);
    expect(detail.lessons).toEqual([]);
    expect(detail.sources).toEqual([]);
    expect(detail.sourceCount).toBe(0);
  });
});
