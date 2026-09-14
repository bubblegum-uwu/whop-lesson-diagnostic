import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  createCreateSynthesisSetHandler,
  createAddSourceToSynthesisSetHandler,
  createAddLessonToSynthesisSetHandler,
  createRemoveSourceFromSynthesisSetHandler,
  type SynthesisSetsRouteDeps,
} from "../src/http/routes/synthesisSets.js";
import {
  createListSynthesisSetRunsHandler,
  createGetSynthesisSetRunHandler,
  createGetSynthesisSetRunInputsHandler,
  createGetSynthesisSetRunOutputHandler,
  createCreateSynthesisSetRunHandler,
  type SynthesisSetRunsRouteDeps,
} from "../src/http/routes/synthesisSetRuns.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { markSynthesisSetRunFailed } from "../src/db/synthesisSetRunsRepo.js";
import { createSynthesisRun, claimNextEligibleSynthesisRun, markSynthesisCompleted } from "../src/db/synthesisRunsRepo.js";
import { createCoursePlaybook, type CreateCoursePlaybookInput } from "../src/db/coursePlaybooksRepo.js";
import { attachLegacyRunToSynthesisSet } from "../src/db/synthesisSetLegacyRunsRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

function setDeps(): SynthesisSetsRouteDeps {
  return { pool };
}
function runDeps(): SynthesisSetRunsRouteDeps {
  return { pool };
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  return source;
}

async function analyzeSource(projectSourceId: number) {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [projectSourceId, randomId("fp")],
  );
  return createProjectSourceAnalysis(pool, {
    projectSourceId,
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
}

async function makeCourse(projectId: number) {
  const course = await upsertCourse(pool, { whopCourseId: randomId("cors"), whopExperienceId: "exp_1", slug: "trading-accelerator", title: "The Trading Accelerator" });
  await pool.query(`UPDATE courses SET project_id = $1 WHERE id = $2`, [projectId, course.id]);
  return course;
}

async function makeLesson(courseId: number, title = "Lesson") {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', 'https://whop.com/x') RETURNING id`,
    [courseId, randomId("lesn"), title],
  );
  return { id: Number(result.rows[0].id) };
}

async function analyzeLesson(lessonId: number) {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [lessonId, randomId("fp")],
  );
  return createLessonAnalysis(pool, {
    lessonId,
    jobId: jobResult.rows[0].job_id,
    status: "completed",
    strategyFound: false,
    validatedJson: { lesson: { title: "t", duration_seconds: 600 }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
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
}

async function makeTerminalCompletedRun(courseId: number, sourceAnalysisIds: number[]): Promise<string> {
  const run = await createSynthesisRun(pool, {
    courseId,
    sourceAnalysisHash: randomId("hash"),
    sourceAnalysisIds,
    model: GEMINI_MODEL,
    synthesisPromptVersion: "v1",
    synthesisSchemaVersion: "v1",
    synthesizerVersion: "v1",
  });
  const leaseOwner = randomId("owner");
  await pool.query(`UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = $2 WHERE run_id = $1`, [run.runId, leaseOwner]);
  await markSynthesisCompleted(pool, run.runId, leaseOwner, { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, estimatedCost: 0.001, processingDurationSeconds: 5 });
  return run.runId;
}

function playbookInput(runId: string): CreateCoursePlaybookInput {
  return {
    runId,
    title: "Recovered Playbook",
    coreFramework: { sections: [] },
    playbook: {
      title: "Recovered Playbook",
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
  };
}

function callCreateSet(projectId: number, name: string) {
  const handler = createCreateSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId) }, body: { name } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callAddSource(projectId: number, setId: number, sourceId: number) {
  const handler = createAddSourceToSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { sourceId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callRemoveSource(projectId: number, setId: number, sourceId: number) {
  const handler = createRemoveSourceFromSynthesisSetHandler(setDeps());
  const { res, statusCode } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), sourceId: String(sourceId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode() }));
}
function callAddLesson(projectId: number, setId: number, lessonId: number) {
  const handler = createAddLessonToSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { lessonId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callListRuns(projectId: number, setId: number) {
  const handler = createListSynthesisSetRunsHandler(runDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callGetRun(projectId: number, setId: number, runId: string) {
  const handler = createGetSynthesisSetRunHandler(runDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), runId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callGetRunInputs(projectId: number, setId: number, runId: string) {
  const handler = createGetSynthesisSetRunInputsHandler(runDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), runId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callGetRunOutput(projectId: number, setId: number, runId: string) {
  const handler = createGetSynthesisSetRunOutputHandler(runDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), runId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callCreateRun(projectId: number, setId: number, body: Record<string, unknown> = {}) {
  const handler = createCreateSynthesisSetRunHandler(runDeps());
  const { res, statusCode, body: respBody } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: respBody() as Record<string, unknown> }));
}

describe("Phase 4M — immutable Synthesis Set Runs", () => {
  it("1/2/3: Run creation snapshots exact current membership, using the exact analysis ids currently resolved (source + lesson)", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const analysis = await analyzeSource(source.id);
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const lessonAnalysis = await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    await callAddLesson(project.id, set.id as number, lesson.id);

    const created = await callCreateRun(project.id, set.id as number);
    expect(created.statusCode).toBe(201);
    expect(created.body.readyCount).toBe(2);
    expect(created.body.skippedNotReadyCount).toBe(0);

    const { body: inputs } = await callGetRunInputs(project.id, set.id as number, created.body.runId as string);
    const rows = inputs.inputs as { kind: string; id: number; analysisId: number }[];
    expect(rows).toHaveLength(2);
    const sourceRow = rows.find((r) => r.kind === "SOURCE")!;
    expect(sourceRow.id).toBe(source.id);
    expect(sourceRow.analysisId).toBe(analysis.analysisId);
    const lessonRow = rows.find((r) => r.kind === "WHOP_LESSON")!;
    expect(lessonRow.id).toBe(lesson.id);
    expect(lessonRow.analysisId).toBe(lessonAnalysis.analysisId);
  });

  it("4: a later Synthesis Set membership change does not alter an already-created Run's snapshot", async () => {
    const project = await makeProject();
    const source1 = await makeYouTubeSource(project.id);
    const source2 = await makeYouTubeSource(project.id);
    await analyzeSource(source1.id);
    await analyzeSource(source2.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source1.id);
    await callAddSource(project.id, set.id as number, source2.id);

    const created = await callCreateRun(project.id, set.id as number);
    expect(created.body.readyCount).toBe(2);

    // Remove source2 from the set AFTER the run was created.
    await callRemoveSource(project.id, set.id as number, source2.id);

    const { body: inputs } = await callGetRunInputs(project.id, set.id as number, created.body.runId as string);
    expect(inputs.inputs).toHaveLength(2); // unchanged — still both sources
  });

  it("5: a later re-analysis does not alter an already-created Run's snapshot — it keeps pointing at the ORIGINAL analysis id", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const firstAnalysis = await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number);

    const secondAnalysis = await analyzeSource(source.id); // re-analyze AFTER the run
    expect(secondAnalysis.analysisId).not.toBe(firstAnalysis.analysisId);

    const { body: inputs } = await callGetRunInputs(project.id, set.id as number, created.body.runId as string);
    const rows = inputs.inputs as { analysisId: number }[];
    expect(rows[0].analysisId).toBe(firstAnalysis.analysisId);
    expect(rows[0].analysisId).not.toBe(secondAnalysis.analysisId);
  });

  it("6: a second explicit Run creates a second, independent immutable Run", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);

    const runA = await callCreateRun(project.id, set.id as number);
    const runB = await callCreateRun(project.id, set.id as number);
    expect(runA.body.runId).not.toBe(runB.body.runId);

    const { body: list } = await callListRuns(project.id, set.id as number);
    const nativeRunIds = (list.runs as { runId: string; kind: string }[]).filter((r) => r.kind === "NATIVE").map((r) => r.runId);
    expect(nativeRunIds).toEqual(expect.arrayContaining([runA.body.runId, runB.body.runId]));
    expect(nativeRunIds).toHaveLength(2);
  });

  it("7: a FAILED Run remains fully queryable, never erased", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number);

    await markSynthesisSetRunFailed(pool, created.body.runId as string, "gemini_error", "Something failed.");

    const { statusCode, body } = await callGetRun(project.id, set.id as number, created.body.runId as string);
    expect(statusCode).toBe(200);
    expect(body.status).toBe("FAILED");
    expect(body.errorType).toBe("gemini_error");
    expect(body.sanitizedError).toBe("Something failed.");

    const { body: list } = await callListRuns(project.id, set.id as number);
    expect((list.runs as { runId: string }[]).some((r) => r.runId === created.body.runId)).toBe(true);
  });

  it("8: a Run from one project/set is never fetchable through a different project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const source = await makeYouTubeSource(projectA.id);
    await analyzeSource(source.id);
    const { body: setA } = await callCreateSet(projectA.id, "Strategies");
    await callAddSource(projectA.id, setA.id as number, source.id);
    const created = await callCreateRun(projectA.id, setA.id as number);

    const { statusCode } = await callGetRun(projectB.id, setA.id as number, created.body.runId as string);
    expect(statusCode).toBe(404);

    const inputsResult = await callGetRunInputs(projectB.id, setA.id as number, created.body.runId as string);
    expect(inputsResult.statusCode).toBe(404);

    // Cross-project create is also rejected (unknown set for that project).
    const crossCreate = await callCreateRun(projectB.id, setA.id as number);
    expect(crossCreate.statusCode).toBe(404);
  });

  it("9: legacy recovered Whop runs remain visible in the unified Run list", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const lessonAnalysis = await analyzeLesson(lesson.id);
    const legacyRunId = await makeTerminalCompletedRun(course.id, [lessonAnalysis.analysisId]);
    await createCoursePlaybook(pool, playbookInput(legacyRunId));
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await attachLegacyRunToSynthesisSet(pool, set.id as number, legacyRunId, project.id);

    const { body: list } = await callListRuns(project.id, set.id as number);
    const runs = list.runs as { runId: string; kind: string; status: string; hasOutput: boolean }[];
    const legacyEntry = runs.find((r) => r.runId === legacyRunId);
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry!.kind).toBe("LEGACY_WHOP");
    expect(legacyEntry!.status).toBe("COMPLETED");
    expect(legacyEntry!.hasOutput).toBe(true);

    const { statusCode, body: getBody } = await callGetRun(project.id, set.id as number, legacyRunId);
    expect(statusCode).toBe(200);
    expect(getBody.kind).toBe("LEGACY_WHOP");
  });

  it("10: reading a legacy Run's output never modifies its existing course_playbooks row", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id);
    const lessonAnalysis = await analyzeLesson(lesson.id);
    const legacyRunId = await makeTerminalCompletedRun(course.id, [lessonAnalysis.analysisId]);
    const input = playbookInput(legacyRunId);
    await createCoursePlaybook(pool, input);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await attachLegacyRunToSynthesisSet(pool, set.id as number, legacyRunId, project.id);

    const before = await pool.query(`SELECT playbook_id, title, core_framework_json, playbook_json, decision_framework_json FROM course_playbooks WHERE run_id = $1`, [legacyRunId]);

    const { statusCode, body } = await callGetRunOutput(project.id, set.id as number, legacyRunId);
    expect(statusCode).toBe(200);
    expect(body.kind).toBe("LEGACY_WHOP");
    expect((body.result as { title: string }).title).toBe(input.title);

    const after = await pool.query(`SELECT playbook_id, title, core_framework_json, playbook_json, decision_framework_json FROM course_playbooks WHERE run_id = $1`, [legacyRunId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("11: creating a Run starts zero new analysis_jobs/project_source_analysis_jobs", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);

    const before = await pool.query(`SELECT COUNT(*) AS n FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    await callCreateRun(project.id, set.id as number);
    const after = await pool.query(`SELECT COUNT(*) AS n FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("12: selecting/deselecting membership itself never creates a Run", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");

    await callAddSource(project.id, set.id as number, source.id);
    await callRemoveSource(project.id, set.id as number, source.id);
    await callAddSource(project.id, set.id as number, source.id);

    const { body: list } = await callListRuns(project.id, set.id as number);
    expect(list.runs).toEqual([]);
  });

  it("13: a partially-ready selection requires explicit confirmation, then snapshots only the ready subset", async () => {
    const project = await makeProject();
    const ready = await makeYouTubeSource(project.id);
    await analyzeSource(ready.id);
    const notReady = await makeYouTubeSource(project.id); // never analyzed
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, ready.id);

    // Directly insert membership for the not-ready source too (bypassing the
    // add-source route's own eligibility gate, which would otherwise refuse
    // it) — the Run-creation endpoint must independently re-check readiness
    // at snapshot time, never trust that membership alone implies ready.
    await pool.query(`INSERT INTO synthesis_set_sources (synthesis_set_id, project_source_id, project_id) VALUES ($1, $2, $3)`, [set.id, notReady.id, project.id]);

    const firstAttempt = await callCreateRun(project.id, set.id as number);
    expect(firstAttempt.statusCode).toBe(409);
    expect(firstAttempt.body.readyCount).toBe(1);
    expect(firstAttempt.body.skippedNotReadyCount).toBe(1);

    // No Run was created by the 409.
    const { body: listAfterRefusal } = await callListRuns(project.id, set.id as number);
    expect(listAfterRefusal.runs).toEqual([]);

    const confirmed = await callCreateRun(project.id, set.id as number, { acknowledgePartial: true });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.body.readyCount).toBe(1);
    expect(confirmed.body.skippedNotReadyCount).toBe(1);

    const { body: inputs } = await callGetRunInputs(project.id, set.id as number, confirmed.body.runId as string);
    expect(inputs.inputs).toHaveLength(1);
    expect((inputs.inputs as { id: number }[])[0].id).toBe(ready.id);
  });

  it("nothing ready at all is rejected outright, acknowledged or not", async () => {
    const project = await makeProject();
    const notReady = await makeYouTubeSource(project.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await pool.query(`INSERT INTO synthesis_set_sources (synthesis_set_id, project_source_id, project_id) VALUES ($1, $2, $3)`, [set.id, notReady.id, project.id]);

    const result = await callCreateRun(project.id, set.id as number, { acknowledgePartial: true });
    expect(result.statusCode).toBe(400);
  });
});
