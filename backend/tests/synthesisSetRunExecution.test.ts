import { describe, it, expect, vi, afterAll } from "vitest";
import { createCreateSynthesisSetHandler, createAddSourceToSynthesisSetHandler, createAddLessonToSynthesisSetHandler, createRemoveSourceFromSynthesisSetHandler } from "../src/http/routes/synthesisSets.js";
import { createCreateSynthesisSetRunHandler, createGetSynthesisSetRunOutputHandler, createListSynthesisSetRunsHandler, type SynthesisSetRunsRouteDeps } from "../src/http/routes/synthesisSetRuns.js";
import type { SynthesisSetsRouteDeps } from "../src/http/routes/synthesisSets.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { getSynthesisSetRunById, claimNextEligibleSynthesisSetRun } from "../src/db/synthesisSetRunsRepo.js";
import { gatherSynthesisSetRunInput } from "../src/synthesis/gatherSynthesisSetRunInput.js";
import { runSynthesisSetRunLoop } from "../src/worker/synthesisSetRunLoop.js";
import { createSynthesisRun, markSynthesisCompleted } from "../src/db/synthesisRunsRepo.js";
import { createCoursePlaybook, getCoursePlaybookByRun, type CreateCoursePlaybookInput } from "../src/db/coursePlaybooksRepo.js";
import { attachLegacyRunToSynthesisSet } from "../src/db/synthesisSetLegacyRunsRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import type { GeminiClient } from "../src/gemini/client.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { SYNTHESIS_PROMPT_VERSION } from "../src/synthesis/version.js";
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
function runDeps(jobTrigger: JobTrigger, geminiModel: string = GEMINI_MODEL): SynthesisSetRunsRouteDeps {
  return { pool, jobTrigger, geminiModel };
}
function fakeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  return source;
}

async function analyzeSource(projectSourceId: number, strategyName = "Break & Retest") {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [projectSourceId, randomId("fp")],
  );
  return createProjectSourceAnalysis(pool, {
    projectSourceId,
    jobId: jobResult.rows[0].job_id,
    status: "completed",
    strategyFound: true,
    validatedJson: {
      lesson: { title: "t", duration_seconds: null },
      strategy_found: true,
      strategies: [
        {
          strategy_name: strategyName,
          market_or_instrument: ["ES"],
          timeframes: ["5m"],
          indicators: ["VWAP"],
          setup_conditions: [],
          entry_rules: [{ description: "Enter", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "e" }],
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
        },
      ],
      knowledge: EMPTY_LESSON_KNOWLEDGE,
    },
    analysisSummary: "Break & Retest",
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
        coverageNote: "",
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
    decisionFramework: { nodes: [], readableSteps: [], scopeLeaks: [], readableStepLeaks: [] },
  };
}

/** The RAW wire shape synthesizeCanonicalStrategy's Gemini call expects — see tests/synthesisLoop.test.ts's identical fixture. */
function validCanonicalStrategyJson() {
  return JSON.stringify({
    name: "Break & Retest",
    purpose: "p",
    markets: ["ES"],
    timeframes: ["5m"],
    sections: [],
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
    sourceLessonIds: [1],
  });
}

/** Same canned-response fake as tests/synthesisLoop.test.ts's makeFakeGemini — every stage's prompt is matched by a stable substring and answered with a minimal valid response for that stage's schema. */
function makeFakeGemini(usage = { inputTokens: 100, outputTokens: 50, thinkingTokens: 10 }): GeminiClient {
  const generateStructured = vi.fn(async (prompt: string) => {
    if (prompt.includes("clustering trading-strategy instances")) {
      const ids = [...prompt.matchAll(/"strategyInstanceId":\s*(\d+)/g)].map((m) => Number(m[1]));
      return {
        text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: ids.length > 0 ? ids : [1], similarityRationale: "r", differencesNotes: "" }] }),
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

function makeThrowingGemini(): GeminiClient {
  const generateStructured = vi.fn(async (prompt: string) => {
    if (prompt.includes("clustering trading-strategy instances")) throw new Error("Simulated Gemini failure during clustering.");
    return { text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } };
  });
  return { uploadFile: vi.fn(), waitUntilActive: vi.fn(), analyzeVideo: vi.fn(), deleteFile: vi.fn(), generateStructured };
}

function callCreateSet(projectId: number, name: string) {
  const handler = createCreateSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId) }, body: { name, description: null } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callAddSource(projectId: number, setId: number, sourceId: number) {
  const handler = createAddSourceToSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { sourceId } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callRemoveSource(projectId: number, setId: number, sourceId: number) {
  const handler = createRemoveSourceFromSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), sourceId: String(sourceId) } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callAddLesson(projectId: number, setId: number, lessonId: number) {
  const handler = createAddLessonToSynthesisSetHandler(setDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body: { lessonId } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callCreateRun(projectId: number, setId: number, jobTrigger: JobTrigger, body: unknown = {}) {
  const handler = createCreateSynthesisSetRunHandler(runDeps(jobTrigger));
  const { res, statusCode, body: respBody } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) }, body } as any, res).then(() => ({ statusCode: statusCode(), body: respBody() as Record<string, unknown> }));
}
function callGetRunOutput(projectId: number, setId: number, runId: string, jobTrigger: JobTrigger) {
  const handler = createGetSynthesisSetRunOutputHandler(runDeps(jobTrigger));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId), runId } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}
function callListRuns(projectId: number, setId: number, jobTrigger: JobTrigger) {
  const handler = createListSynthesisSetRunsHandler(runDeps(jobTrigger));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId: String(projectId), setId: String(setId) } } as any, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("Phase 4M follow-up — native Synthesis Set Run EXECUTION", () => {
  it("1: POST Run freezes exact analysis IDs and leaves it QUEUED — creation never itself executes anything", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const analysis = await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);

    const trigger = fakeJobTrigger();
    const created = await callCreateRun(project.id, set.id as number, trigger);
    expect(created.statusCode).toBe(201);
    expect(created.body.status).toBe("QUEUED");
    expect(trigger.triggerRun).toHaveBeenCalledTimes(1);

    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("QUEUED");
    expect(run?.model).toBe(GEMINI_MODEL);

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.knowledgeSources.map((k) => k.analysisId)).toEqual([analysis.analysisId]);
  });

  it("2: the executor's gathered input reflects ONLY the frozen Run snapshot, never a LARGER current membership", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const trigger = fakeJobTrigger();
    const created = await callCreateRun(project.id, set.id as number, trigger);

    // Add a SECOND, already-analyzed source AFTER the Run was created.
    const secondSource = await makeYouTubeSource(project.id);
    await analyzeSource(secondSource.id);
    await callAddSource(project.id, set.id as number, secondSource.id);

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.lessons).toHaveLength(1); // still just the one frozen at creation, never the now-larger current membership of 2
  });

  it("3: removing a source from the Synthesis Set AFTER Run creation never changes what the executor gathers for that Run", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const trigger = fakeJobTrigger();
    const created = await callCreateRun(project.id, set.id as number, trigger);

    await callRemoveSource(project.id, set.id as number, source.id);

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.lessons).toHaveLength(1);
    expect(input.knowledgeSources).toHaveLength(1);
  });

  it("4: re-analyzing a source AFTER Run creation never changes which exact analysis content the executor gathers for that Run", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id, "Original Strategy Name");
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const trigger = fakeJobTrigger();
    const created = await callCreateRun(project.id, set.id as number, trigger);

    // A newer analysis for the SAME source, with visibly different content.
    await analyzeSource(source.id, "Brand New Strategy Name");

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.instances).toHaveLength(1);
    expect(input.instances[0].strategyName).toBe("Original Strategy Name");
  });

  it("5: a QUEUED Run transitions to RUNNING then COMPLETED once the worker loop claims and executes it", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    const before = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(before?.status).toBe("QUEUED");
    expect(before?.startedAt).toBeNull();

    const gemini = makeFakeGemini();
    await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const after = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.startedAt).not.toBeNull();
    expect(after?.completedAt).not.toBeNull();
  });

  it("6: a failed execution becomes FAILED with persisted error info and stays fully queryable — never erased", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    const gemini = makeThrowingGemini();
    await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const after = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(after?.status).toBe("FAILED");
    expect(after?.sanitizedError).toContain("Simulated Gemini failure");
    expect(after?.errorType).toBeTruthy();

    const listed = await callListRuns(project.id, set.id as number, fakeJobTrigger());
    expect((listed.body.runs as { runId: string; status: string }[]).some((r) => r.runId === created.body.runId && r.status === "FAILED")).toBe(true);
  });

  it("7: a COMPLETED Run exposes its persisted output via GET .../runs/:runId/output", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const { statusCode, body } = await callGetRunOutput(project.id, set.id as number, created.body.runId as string, fakeJobTrigger());
    expect(statusCode).toBe(200);
    expect(body.kind).toBe("NATIVE");
    expect(body.result.playbook.title).toBe("Playbook");
    expect(body.result.clusters).toHaveLength(1);
    expect(body.result.coreFramework).toBeDefined();
    expect(body.result.decisionFramework).toBeDefined();
  });

  it("8: model/prompt version/cost/usage/timestamps are all persisted on completion", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.model).toBe(GEMINI_MODEL);
    expect(run?.promptVersion).toBeTruthy();
    expect(run?.inputTokens).not.toBeNull();
    expect(run?.outputTokens).not.toBeNull();
    expect(run?.estimatedCost).not.toBeNull();
    expect(run?.processingDurationSeconds).not.toBeNull();
    expect(run?.startedAt).not.toBeNull();
    expect(run?.completedAt).not.toBeNull();
  });

  it("9: a generic-source-only native Run executes to completion", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("COMPLETED");
  });

  it("10: a Whop-lesson-only native Run executes from the exact frozen lesson_analysis IDs", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id, "Lesson A");
    const lessonAnalysis = await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddLesson(project.id, set.id as number, lesson.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.knowledgeSources.map((k) => k.analysisId)).toEqual([lessonAnalysis.analysisId]);

    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("COMPLETED");
  });

  it("11: a mixed generic-source + Whop-lesson native Run executes to completion", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id, "Lesson A");
    await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    await callAddLesson(project.id, set.id as number, lesson.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    const input = await gatherSynthesisSetRunInput(pool, set.name as string, created.body.runId as string);
    expect(input.lessons).toHaveLength(2);

    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("COMPLETED");
  });

  it("12: creating/selecting membership alone creates zero Runs, and the worker loop finds nothing to claim", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    await callRemoveSource(project.id, set.id as number, source.id);
    await callAddSource(project.id, set.id as number, source.id);

    const gemini = makeFakeGemini();
    await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(gemini.generateStructured).not.toHaveBeenCalled();

    const listed = await callListRuns(project.id, set.id as number, fakeJobTrigger());
    expect(listed.body.runs).toHaveLength(0);
  });

  it("13: Run creation and execution never trigger a new analysis job for any source or lesson", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);

    const before = await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());
    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const after = await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);

    expect(after.rows[0].n).toBe(before.rows[0].n);
    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("COMPLETED");
  });

  it("14: duplicate worker pickup never produces duplicate execution or overwrites a completed Run's output", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await analyzeSource(source.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddSource(project.id, set.id as number, source.id);
    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

    // Race: claim the row directly with one lease owner BEFORE the loop runs, simulating another in-flight worker execution already holding it.
    const otherOwner = randomId("other-worker");
    const claimedByOther = await claimNextEligibleSynthesisSetRun(pool, otherOwner);
    expect(claimedByOther?.runId).toBe(created.body.runId);

    // A second loop invocation must find NOTHING to claim — the row is RUNNING with a live (non-expired) lease held by someone else.
    const gemini = makeFakeGemini();
    await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(gemini.generateStructured).not.toHaveBeenCalled();

    const run = await getSynthesisSetRunById(pool, created.body.runId as string);
    expect(run?.status).toBe("RUNNING"); // still held by "otherOwner" — never reclaimed or double-processed
  });

  it("15: recovered legacy Whop runs remain completely untouched and visible alongside a native Run's own creation and execution", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const lesson = await makeLesson(course.id, "Lesson A");
    const lessonAnalysis = await analyzeLesson(lesson.id);
    const { body: set } = await callCreateSet(project.id, "Strategies");
    await callAddLesson(project.id, set.id as number, lesson.id);

    const legacyRun = await createSynthesisRun(pool, {
      courseId: course.id,
      sourceAnalysisHash: randomId("hash"),
      sourceAnalysisIds: [lessonAnalysis.analysisId],
      model: GEMINI_MODEL,
      synthesisPromptVersion: "v1",
      synthesisSchemaVersion: "v1",
      synthesizerVersion: "v1",
    });
    const leaseOwner = randomId("owner");
    await pool.query(`UPDATE synthesis_runs SET status = 'RUNNING', lease_owner = $2 WHERE run_id = $1`, [legacyRun.runId, leaseOwner]);
    await markSynthesisCompleted(pool, legacyRun.runId, leaseOwner, { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, estimatedCost: 0.001, processingDurationSeconds: 5 });
    await createCoursePlaybook(pool, playbookInput(legacyRun.runId));
    await attachLegacyRunToSynthesisSet(pool, set.id as number, legacyRun.runId, project.id);

    const legacyPlaybookBefore = await getCoursePlaybookByRun(pool, legacyRun.runId);

    const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());
    await runSynthesisSetRunLoop({ pool, gemini: makeFakeGemini(), model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

    const legacyPlaybookAfter = await getCoursePlaybookByRun(pool, legacyRun.runId);
    expect(legacyPlaybookAfter).toEqual(legacyPlaybookBefore);

    const listed = await callListRuns(project.id, set.id as number, fakeJobTrigger());
    const kinds = (listed.body.runs as { runId: string; kind: string; status: string }[]).map((r) => `${r.kind}:${r.runId}:${r.status}`);
    expect(kinds).toContain(`LEGACY_WHOP:${legacyRun.runId}:COMPLETED`);
    expect(kinds.some((k) => k.startsWith(`NATIVE:${created.body.runId}:COMPLETED`))).toBe(true);
  });

  describe("Review follow-up — frozen model/promptVersion provenance, and lease/advisory-lock documentation", () => {
    it("16: execution uses the model FROZEN ON THE RUN, never the worker's currently-configured model — Run metadata still records the frozen model afterward", async () => {
      const project = await makeProject();
      const source = await makeYouTubeSource(project.id);
      await analyzeSource(source.id);
      const { body: set } = await callCreateSet(project.id, "Strategies");
      await callAddSource(project.id, set.id as number, source.id);

      const MODEL_A = "model-frozen-at-creation-time";
      const MODEL_B = "model-configured-later-at-execution-time";

      // Create the Run while the route's own configured model is A.
      const createHandler = createCreateSynthesisSetRunHandler(runDeps(fakeJobTrigger(), MODEL_A));
      const { res, body: respBody } = makeResponse();
      await createHandler({ params: { projectId: String(project.id), setId: String(set.id) }, body: {} } as any, res);
      const created = respBody() as Record<string, unknown>;

      const beforeExecution = await getSynthesisSetRunById(pool, created.runId as string);
      expect(beforeExecution?.model).toBe(MODEL_A);

      // Records the exact model string every generateStructured call actually received.
      const modelsSeenByGemini: string[] = [];
      const baseGemini = makeFakeGemini();
      const gemini: GeminiClient = {
        ...baseGemini,
        generateStructured: vi.fn((prompt: string, model: string, ...rest: unknown[]) => {
          modelsSeenByGemini.push(model);
          return (baseGemini.generateStructured as unknown as (...args: unknown[]) => unknown)(prompt, model, ...rest) as ReturnType<GeminiClient["generateStructured"]>;
        }),
      };

      // Execute the worker while ITS OWN configured default is a DIFFERENT model, B.
      await runSynthesisSetRunLoop({ pool, gemini, model: MODEL_B, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

      expect(modelsSeenByGemini.length).toBeGreaterThan(0);
      expect(modelsSeenByGemini.every((m) => m === MODEL_A)).toBe(true);
      expect(modelsSeenByGemini).not.toContain(MODEL_B);

      const afterExecution = await getSynthesisSetRunById(pool, created.runId as string);
      expect(afterExecution?.status).toBe("COMPLETED");
      expect(afterExecution?.model).toBe(MODEL_A); // still the frozen value — execution never rewrites it
    });

    it("17: a Run somehow missing its frozen model fails loudly rather than silently executing under the worker's currently-configured model", async () => {
      const project = await makeProject();
      const source = await makeYouTubeSource(project.id);
      await analyzeSource(source.id);
      const { body: set } = await callCreateSet(project.id, "Strategies");
      await callAddSource(project.id, set.id as number, source.id);
      const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

      // Simulates a Run whose frozen model is unexpectedly missing (e.g. a malformed/legacy row) — never producible through the real create path, which always freezes deps.geminiModel.
      await pool.query(`UPDATE synthesis_set_runs SET model = NULL WHERE run_id = $1`, [created.body.runId]);

      const gemini = makeFakeGemini();
      await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

      expect(gemini.generateStructured).not.toHaveBeenCalled(); // never silently falls back to deps.model and executes anyway
      const run = await getSynthesisSetRunById(pool, created.body.runId as string);
      expect(run?.status).toBe("FAILED");
      expect(run?.sanitizedError).toContain("no frozen model");
    });

    it("18: a Run frozen under an older synthesis prompt version than the worker currently implements refuses to execute rather than silently running the CURRENT prompt logic under the OLD claimed version", async () => {
      const project = await makeProject();
      const source = await makeYouTubeSource(project.id);
      await analyzeSource(source.id);
      const { body: set } = await callCreateSet(project.id, "Strategies");
      await callAddSource(project.id, set.id as number, source.id);
      const created = await callCreateRun(project.id, set.id as number, fakeJobTrigger());

      const beforeExecution = await getSynthesisSetRunById(pool, created.body.runId as string);
      expect(beforeExecution?.promptVersion).toBe(SYNTHESIS_PROMPT_VERSION); // sanity: the real create path really did freeze the current version

      // Simulates a Run that survived a deploy which bumped SYNTHESIS_PROMPT_VERSION — frozen under an older one this worker no longer implements.
      await pool.query(`UPDATE synthesis_set_runs SET prompt_version = 'v0-superseded' WHERE run_id = $1`, [created.body.runId]);

      const gemini = makeFakeGemini();
      await runSynthesisSetRunLoop({ pool, gemini, model: GEMINI_MODEL, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });

      expect(gemini.generateStructured).not.toHaveBeenCalled(); // never runs current prompt logic under a false/stale claimed version
      const run = await getSynthesisSetRunById(pool, created.body.runId as string);
      expect(run?.status).toBe("FAILED");
      expect(run?.sanitizedError).toContain("v0-superseded");
      expect(run?.sanitizedError).toContain(SYNTHESIS_PROMPT_VERSION);
      // The Run's own promptVersion field is never silently rewritten to match what actually ran (nothing ran) — it stays exactly as frozen, still queryable/honest.
      expect(run?.promptVersion).toBe("v0-superseded");
    });
  });
});
