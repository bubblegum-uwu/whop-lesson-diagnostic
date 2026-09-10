import { describe, it, expect, afterAll, beforeEach } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, listLessons } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis } from "../src/db/lessonAnalysesRepo.js";
import { createSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { createGetUsageHandler } from "../src/http/routes/usage.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import type { Strategy } from "../src/gemini/schema.js";
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
  await pool.query("TRUNCATE project_source_analysis_jobs, project_source_analyses, project_sources RESTART IDENTITY CASCADE");
  // Deliberately never truncates `projects` — matches
  // projectSourcesRoutes.test.ts/projectSynthesisRoutes.test.ts's existing
  // convention: each test creates its own project(s) via randomId()-named
  // rows and only ever asserts on those.
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

async function makeCourse(projectId?: number, overrides: { title?: string } = {}) {
  const course = await upsertCourse(pool, {
    whopCourseId: randomId("cors"),
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

/** A single completed lesson analysis with an explicit cost and completion timestamp — the exact controls needed to test month-boundary attribution. */
async function makeAnalyzedLesson(courseId: number, opts: { cost: number; completedAt: Date; title?: string }) {
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
      title: opts.title ?? "Break and Retest",
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
    await pool.query(`INSERT INTO analysis_jobs (lesson_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`, [
      lesson.id,
      randomId("fp"),
    ])
  ).rows[0].job_id;

  return createLessonAnalysis(pool, {
    lessonId: lesson.id,
    jobId,
    status: "completed",
    strategyFound: true,
    validatedJson: {
      lesson: { title: lesson.title, duration_seconds: 600 },
      strategy_found: true,
      strategies: [makeStrategy()],
      knowledge: EMPTY_LESSON_KNOWLEDGE,
    },
    analysisSummary: "Break & Retest",
    model: GEMINI_MODEL,
    promptVersion: "v1",
    extractorVersion: "v1",
    schemaVersion: "v1",
    analysisFingerprint: randomId("fp"),
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    processingDurationSeconds: 60,
    inputTokens: 100,
    outputTokens: 20,
    thinkingTokens: 0,
    estimatedCost: opts.cost,
  });
}

/** Phase 4H-B — a project_source_analyses row with explicit cost/timestamp, mirroring makeAnalyzedLesson's shape for the YouTube path. */
async function makeAnalyzedProjectSource(projectId: number, opts: { cost: number; completedAt: Date }) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  const jobId = (
    await pool.query(`INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`, [
      source.id,
      randomId("fp"),
    ])
  ).rows[0].job_id;

  return createProjectSourceAnalysis(pool, {
    projectSourceId: source.id,
    jobId,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: {
      lesson: { title: "YouTube video", duration_seconds: null },
      strategy_found: false,
      strategies: [],
      knowledge: EMPTY_LESSON_KNOWLEDGE,
    },
    analysisSummary: "No strategy found.",
    model: GEMINI_MODEL,
    promptVersion: "v2",
    extractorVersion: "v2",
    schemaVersion: "v2",
    analysisFingerprint: randomId("fp"),
    startedAt: opts.completedAt,
    completedAt: opts.completedAt,
    processingDurationSeconds: 10,
    inputTokens: 50,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: opts.cost,
  });
}

/** A synthesis_runs row with explicit status/cost/timestamps — createSynthesisRun always uses DB defaults (now()), so the timestamps are set with a direct UPDATE afterward, same pattern as courseSynthesisRoutes.test.ts's progress-manipulation tests. */
async function makeSynthesisRun(courseId: number, opts: { cost: number; status?: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"; completedAt?: Date | null; createdAt?: Date }) {
  const run = await createSynthesisRun(pool, {
    courseId,
    sourceAnalysisHash: randomId("hash"),
    sourceAnalysisIds: [],
    model: GEMINI_MODEL,
    synthesisPromptVersion: "v1",
    synthesisSchemaVersion: "v1",
    synthesizerVersion: "v1",
  });
  await pool.query(
    `UPDATE synthesis_runs SET status = $2, estimated_cost = $3, completed_at = $4, created_at = COALESCE($5, created_at) WHERE run_id = $1`,
    [run.runId, opts.status ?? "COMPLETED", opts.cost, opts.completedAt ?? null, opts.createdAt ?? null],
  );
  return run;
}

function currentMonthStartUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function midCurrentMonth(): Date {
  return new Date(currentMonthStartUTC().getTime() + 5 * 24 * 60 * 60 * 1000);
}

/** Guaranteed to fall in the calendar month before the current one, regardless of which month "now" actually is (handles year rollover correctly since it's arithmetic on the real boundary, not a naive "-1 month"). */
function lastMomentOfPreviousMonth(): Date {
  return new Date(currentMonthStartUTC().getTime() - 1000);
}

async function callUsage(query: Record<string, string> = {}) {
  const handler = createGetUsageHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  await handler({ query } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as Record<string, unknown> };
}

interface UsageBody {
  period: { start: string; end: string; label: string };
  total: { analysisCost: number; synthesisCost: number; totalCost: number };
  projects: {
    projectId: number;
    projectName: string;
    projectType: string;
    analysisCost: number;
    synthesisCost: number;
    totalCost: number;
    analysisRuns: number;
    lessonsAnalyzed: number;
    sourcesAnalyzed: number;
    synthesisRuns: number;
  }[];
}

function findProject(body: UsageBody, projectId: number) {
  return body.projects.find((p) => p.projectId === projectId);
}

describe("GET /api/usage", () => {
  it("A: an authenticated current-month usage request succeeds", async () => {
    const { statusCode, body } = await callUsage({ period: "current_month" });
    expect(statusCode).toBe(200);
    expect((body as unknown as UsageBody).period.label).toMatch(/\d{4}/);
  });

  it("A: defaults to current_month when no period is given", async () => {
    const { statusCode } = await callUsage({});
    expect(statusCode).toBe(200);
  });

  it("rejects an unsupported period deterministically", async () => {
    const { statusCode, body } = await callUsage({ period: "lifetime" });
    expect(statusCode).toBe(400);
    expect((body.error as { type: string }).type).toBe("unsupported_period");
  });

  it("B/D: total analysis cost is derived correctly and total = analysis + synthesis", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 1.5, completedAt: midCurrentMonth() });
    await makeAnalyzedLesson(course.id, { cost: 2.25, completedAt: midCurrentMonth(), title: "Second Lesson" });

    const { body } = await callUsage();
    const parsed = body as unknown as UsageBody;
    const row = findProject(parsed, project.id)!;
    expect(row.analysisCost).toBeCloseTo(3.75, 5);
    expect(row.synthesisCost).toBe(0);
    expect(row.totalCost).toBeCloseTo(3.75, 5);
    expect(parsed.total.analysisCost).toBeGreaterThanOrEqual(3.75);
    expect(parsed.total.totalCost).toBeCloseTo(parsed.total.analysisCost + parsed.total.synthesisCost, 5);
  });

  it("C/J: total synthesis cost is derived correctly and matches the persisted synthesis_run cost", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeSynthesisRun(course.id, { cost: 4.2, status: "COMPLETED", completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.synthesisCost).toBeCloseTo(4.2, 5);
    expect(row.analysisCost).toBe(0);
    expect(row.totalCost).toBeCloseTo(4.2, 5);
    expect(row.synthesisRuns).toBe(1);
  });

  it("D: project total combines analysis and synthesis for the same project", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 8.94, completedAt: midCurrentMonth() });
    await makeSynthesisRun(course.id, { cost: 6.42, status: "COMPLETED", completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBeCloseTo(8.94, 5);
    expect(row.synthesisCost).toBeCloseTo(6.42, 5);
    expect(row.totalCost).toBeCloseTo(15.36, 5);
  });

  it("E: project A's usage is isolated from project B's", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const courseA = await makeCourse(projectA.id, { title: "Project A Course" });
    const courseB = await makeCourse(projectB.id, { title: "Project B Course" });
    await makeAnalyzedLesson(courseA.id, { cost: 5, completedAt: midCurrentMonth() });
    await makeAnalyzedLesson(courseB.id, { cost: 9, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const parsed = body as unknown as UsageBody;
    expect(findProject(parsed, projectA.id)!.analysisCost).toBeCloseTo(5, 5);
    expect(findProject(parsed, projectB.id)!.analysisCost).toBeCloseTo(9, 5);
  });

  it("F: a project with zero spend this month still appears, with $0 fields", async () => {
    const project = await makeProject();
    await makeCourse(project.id);

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row).toBeDefined();
    expect(row.analysisCost).toBe(0);
    expect(row.synthesisCost).toBe(0);
    expect(row.totalCost).toBe(0);
    expect(row.analysisRuns).toBe(0);
    expect(row.lessonsAnalyzed).toBe(0);
    expect(row.synthesisRuns).toBe(0);
  });

  it("F: a project with no courses at all still appears with $0 fields", async () => {
    const project = await makeProject();
    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row).toBeDefined();
    expect(row.totalCost).toBe(0);
  });

  it("G: cost from a course with no assigned project is never attributed to any project, and never appears in the projects list", async () => {
    const orphanCourse = await makeCourse(undefined, { title: "Orphaned Course" }); // no project_id set
    await makeAnalyzedLesson(orphanCourse.id, { cost: 100, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const parsed = body as unknown as UsageBody;
    expect(parsed.projects.some((p) => p.projectName === undefined)).toBe(false);
    // The $100 orphaned cost must not silently land in any real project's total.
    for (const row of parsed.projects) {
      expect(row.analysisCost).not.toBeCloseTo(100, 5);
    }
  });

  it("H: costs completed in the previous month are excluded from the current-month total", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 50, completedAt: lastMomentOfPreviousMonth() });
    await makeSynthesisRun(course.id, { cost: 30, status: "COMPLETED", completedAt: lastMomentOfPreviousMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(0);
    expect(row.synthesisCost).toBe(0);
    expect(row.totalCost).toBe(0);
  });

  it("I: the current-month boundary includes the first instant of this month and excludes the instant before it", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 1, completedAt: currentMonthStartUTC(), title: "Right at boundary" });
    await makeAnalyzedLesson(course.id, { cost: 2, completedAt: lastMomentOfPreviousMonth(), title: "Just before boundary" });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBeCloseTo(1, 5);
    expect(row.lessonsAnalyzed).toBe(1);
  });

  it("J: a RUNNING synthesis run's incrementally-persisted cost counts toward usage — actual incurred spend, not only successful results", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeSynthesisRun(course.id, { cost: 0.75, status: "RUNNING", completedAt: null, createdAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.synthesisCost).toBeCloseTo(0.75, 5);
  });

  it("J: a FAILED synthesis run's cost-so-far still counts toward usage", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeSynthesisRun(course.id, { cost: 1.1, status: "FAILED", completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.synthesisCost).toBeCloseTo(1.1, 5);
  });

  it("K: analysis cost is summed exactly once per lesson_analyses row, never duplicated via usage_records", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    const analysis = await makeAnalyzedLesson(course.id, { cost: 3, completedAt: midCurrentMonth() });
    // Simulates the real worker's own write path (see worker/mainLoop.ts) — a
    // usage_records row referencing the SAME analysis, with the SAME cost.
    await pool.query(
      `INSERT INTO usage_records (analysis_id, model, input_tokens, output_tokens, thinking_tokens, video_duration_seconds, estimated_cost, pricing_version, processing_duration_seconds)
       VALUES ($1, $2, 100, 20, 0, 600, $3, 'v1', 60)`,
      [analysis.analysisId, GEMINI_MODEL, 3],
    );

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    // If usage_records were also summed, this would be 6, not 3.
    expect(row.analysisCost).toBeCloseTo(3, 5);
  });

  it("L: no Whop connection state is consulted (no auth_sessions row exists in this test at all)", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 1, completedAt: midCurrentMonth() });

    const { statusCode } = await callUsage();
    expect(statusCode).toBe(200);
  });

  it("M: a General Knowledge project with no activity shows zero, never fabricated capability", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.projectType).toBe("GENERAL_KNOWLEDGE");
    expect(row.totalCost).toBe(0);
  });

  it("N: a project with zero underlying activity data anywhere returns a valid, well-formed zero-usage response, not an error", async () => {
    // Deliberately does NOT truncate the shared `projects` table — sibling
    // test files (e.g. projectsRoutes.test.ts) depend on the real
    // migration-seeded MasterMind row surviving the whole suite, and this
    // file's own beforeEach never touches `projects` for the same reason
    // (see the comment above). A brand-new project with no course/analysis/
    // synthesis fixtures at all is the safe equivalent of "empty database"
    // for this one project's row: nothing was ever persisted for it.
    const project = await makeProject();
    const { statusCode, body } = await callUsage();
    expect(statusCode).toBe(200);
    const parsed = body as unknown as UsageBody;
    expect(Array.isArray(parsed.projects)).toBe(true);
    const row = findProject(parsed, project.id)!;
    expect(row).toEqual({
      projectId: project.id,
      projectName: project.name,
      projectType: "TRADING_STRATEGIES",
      analysisCost: 0,
      synthesisCost: 0,
      totalCost: 0,
      analysisRuns: 0,
      lessonsAnalyzed: 0,
      sourcesAnalyzed: 0,
      synthesisRuns: 0,
    });
  });

  it("O: monetary outputs are deterministic — rounded to 2 decimal places, no floating-point noise", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    // Values chosen so naive floating-point addition (0.1 + 0.2) produces
    // visible trailing noise (0.30000000000000004) unless rounded.
    await makeAnalyzedLesson(course.id, { cost: 0.1, completedAt: midCurrentMonth() });
    await makeAnalyzedLesson(course.id, { cost: 0.2, completedAt: midCurrentMonth(), title: "Second" });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(0.3);
    expect(Number.isInteger(row.analysisCost * 100)).toBe(true);
  });

  it("T: a project's YouTube (project-source) analysis cost is included in analysisCost/totalCost", async () => {
    const project = await makeProject();
    await makeAnalyzedProjectSource(project.id, { cost: 0.5, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(0.5);
    expect(row.totalCost).toBe(0.5);
    expect(row.sourcesAnalyzed).toBe(1);
  });

  it("T: a project's Whop AND YouTube analysis costs are combined into ONE analysisCost total", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
    await makeAnalyzedLesson(course.id, { cost: 1.0, completedAt: midCurrentMonth() });
    await makeAnalyzedProjectSource(project.id, { cost: 0.25, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(1.25);
    expect(row.lessonsAnalyzed).toBe(1);
    expect(row.sourcesAnalyzed).toBe(1);
  });

  it("U: YouTube analysis cost is never double-counted — summed exactly once per project_source_analyses row, no separate usage-records-equivalent table exists to duplicate it", async () => {
    const project = await makeProject();
    await makeAnalyzedProjectSource(project.id, { cost: 0.4, completedAt: midCurrentMonth() });
    await makeAnalyzedProjectSource(project.id, { cost: 0.6, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(1.0);
    expect(row.sourcesAnalyzed).toBe(2);
  });

  it("U: a YouTube source analyzed in a PREVIOUS month is excluded from the current-month total, same boundary as Whop lessons", async () => {
    const project = await makeProject();
    await makeAnalyzedProjectSource(project.id, { cost: 5, completedAt: lastMomentOfPreviousMonth() });

    const { body } = await callUsage();
    const row = findProject(body as unknown as UsageBody, project.id)!;
    expect(row.analysisCost).toBe(0);
    expect(row.sourcesAnalyzed).toBe(0);
  });

  it("E: a different project's YouTube analysis cost is never attributed to this project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await makeAnalyzedProjectSource(projectB.id, { cost: 9, completedAt: midCurrentMonth() });

    const { body } = await callUsage();
    const rowA = findProject(body as unknown as UsageBody, projectA.id)!;
    expect(rowA.analysisCost).toBe(0);
    expect(rowA.sourcesAnalyzed).toBe(0);
  });
});
