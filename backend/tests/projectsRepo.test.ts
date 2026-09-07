import { describe, it, expect, afterAll } from "vitest";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, type SyncLessonInput } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis, type CreateLessonAnalysisInput } from "../src/db/lessonAnalysesRepo.js";
import { createJob } from "../src/db/analysisJobsRepo.js";
import { createSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { listProjects, getProjectById, getProjectForCourse, getProjectStats } from "../src/db/projectsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

/** The real, stable identity of the configured Trading Accelerator course — matches WHOP_COURSE_ID in backend/README.md's deploy commands. This is exactly what the Phase 4B migration's backfill targets (see 1789300000000_project-model.sql). */
const MASTERMIND_WHOP_COURSE_ID = "cors_4lb7N3oassoZwHJvrufOYy";

/** The migration's exact backfill statement, re-run here to prove its behavior directly (this repo has no dedicated migration-file test runner — see testDb.ts). */
async function runMasterMindBackfill(whopCourseId: string) {
  return pool.query(
    `UPDATE courses SET project_id = (SELECT id FROM projects WHERE name = 'MasterMind') WHERE whop_course_id = $1`,
    [whopCourseId],
  );
}

interface TestProject {
  id: number;
  name: string;
}

/** Inserts an isolated project row directly (no createProject() exists yet — POST /api/projects is deferred to Phase 4C, see PR description). Keeps stats assertions independent of the shared MasterMind row's accumulated test data. */
async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<TestProject> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`,
    [name, projectType],
  );
  return { id: Number(result.rows[0].id), name };
}

async function makeCourse(projectId?: number) {
  const course = await upsertCourse(pool, {
    whopCourseId: randomId("cors"),
    whopExperienceId: "exp_gdmood6JIzSsE7",
    slug: "scarface-trades-mastermind",
    title: "Scarface Trades Mastermind",
  });
  if (projectId !== undefined) {
    await pool.query(`UPDATE courses SET project_id = $1 WHERE id = $2`, [projectId, course.id]);
  }
  return course;
}

function lesson(overrides: Partial<SyncLessonInput> = {}): SyncLessonInput {
  return {
    whopLessonId: randomId("lesn"),
    title: "Support & Resistance",
    lessonType: "video",
    visibility: "visible",
    chapterWhopId: "chap_1",
    chapterTitle: "Foundations",
    chapterOrder: 1,
    courseOrder: 1,
    durationSeconds: 2640,
    videoAssetStatus: "ready",
    videoAvailable: true,
    sourceUrl: "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_x/lessons/lesn_x/",
    ...overrides,
  };
}

function analysisInput(lessonId: number, jobId: string, overrides: Partial<CreateLessonAnalysisInput> = {}): CreateLessonAnalysisInput {
  return {
    lessonId,
    jobId,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: EMPTY_LESSON_KNOWLEDGE,
    analysisSummary: "No strategy found.",
    model: "gemini-3.8-flash",
    promptVersion: "test",
    extractorVersion: "test",
    schemaVersion: "test",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 1,
    inputTokens: 1,
    outputTokens: 1,
    thinkingTokens: 0,
    estimatedCost: 0,
    ...overrides,
  };
}

describe("projectsRepo", () => {
  it("the Phase 4B migration seeds exactly one MasterMind project of type TRADING_STRATEGIES", async () => {
    const projects = await listProjects(pool);
    const masterMinds = projects.filter((p) => p.name === "MasterMind");
    expect(masterMinds).toHaveLength(1);
    expect(masterMinds[0].projectType).toBe("TRADING_STRATEGIES");
  });

  it("getProjectById returns a project by id", async () => {
    const project = await makeProject();
    const found = await getProjectById(pool, project.id);
    expect(found?.name).toBe(project.name);
    expect(found?.projectType).toBe("TRADING_STRATEGIES");
  });

  it("getProjectById returns null for an unknown id", async () => {
    expect(await getProjectById(pool, 999_999_999)).toBeNull();
  });

  it("getProjectForCourse resolves the project a course belongs to", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const course = await makeCourse(project.id);
    const found = await getProjectForCourse(pool, course.id);
    expect(found?.id).toBe(project.id);
  });

  it("getProjectForCourse returns null for a course with no project association", async () => {
    const course = await makeCourse();
    const found = await getProjectForCourse(pool, course.id);
    expect(found).toBeNull();
  });

  it("getProjectStats counts courses/lessons/analyzed lessons and reports the latest synthesis run, scoped to just this project", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);

    const inputs = [lesson(), lesson(), lesson()];
    await syncLessons(pool, course.id, inputs);
    const lessonRows = await pool.query<{ id: string }>(`SELECT id FROM lessons WHERE course_id = $1 ORDER BY id`, [course.id]);
    const lessonIds = lessonRows.rows.map((r) => Number(r.id));

    const jobA = await createJob(pool, lessonIds[0], randomId("fp"));
    const jobB = await createJob(pool, lessonIds[1], randomId("fp"));
    await createLessonAnalysis(pool, analysisInput(lessonIds[0], jobA.jobId));
    await createLessonAnalysis(pool, analysisInput(lessonIds[1], jobB.jobId));

    await createSynthesisRun(pool, {
      courseId: course.id,
      sourceAnalysisHash: randomId("hash"),
      sourceAnalysisIds: [],
      model: "gemini-3.8-flash",
      synthesisPromptVersion: "test",
      synthesisSchemaVersion: "test",
      synthesizerVersion: "test",
    });

    const stats = await getProjectStats(pool, project.id);
    expect(stats.courseCount).toBe(1);
    expect(stats.lessonCount).toBe(3);
    expect(stats.analyzedLessonCount).toBe(2);
    expect(stats.latestSynthesisStatus).toBe("QUEUED");
    expect(stats.latestSynthesisCompletedAt).toBeNull();
  });

  it("getProjectStats reports zeros and nulls for a project with no course yet", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const stats = await getProjectStats(pool, project.id);
    expect(stats).toEqual({
      courseCount: 0,
      lessonCount: 0,
      analyzedLessonCount: 0,
      latestSynthesisStatus: null,
      latestSynthesisCompletedAt: null,
    });
  });
});

describe("Phase 4B migration backfill (1789300000000_project-model)", () => {
  it("A: assigns the configured Trading Accelerator course — matched by its whop_course_id — to MasterMind", async () => {
    const course = await upsertCourse(pool, {
      whopCourseId: MASTERMIND_WHOP_COURSE_ID,
      whopExperienceId: "exp_gdmood6JIzSsE7",
      slug: "scarface-trades-mastermind",
      title: "Scarface Trades Mastermind",
    });

    await runMasterMindBackfill(MASTERMIND_WHOP_COURSE_ID);

    const found = await getProjectForCourse(pool, course.id);
    expect(found?.name).toBe("MasterMind");
    expect(found?.projectType).toBe("TRADING_STRATEGIES");
  });

  it("B: does NOT assign an unrelated course present at migration time — only an exact whop_course_id match qualifies, never a blanket 'unassigned' backfill", async () => {
    const unrelated = await makeCourse(); // random whopCourseId, never MASTERMIND_WHOP_COURSE_ID

    await runMasterMindBackfill(MASTERMIND_WHOP_COURSE_ID);

    const found = await getProjectForCourse(pool, unrelated.id);
    expect(found).toBeNull();
  });

  it("C: succeeds with zero rows updated when the target course doesn't exist yet (e.g. a fresh database) — MasterMind is still created and available", async () => {
    const result = await runMasterMindBackfill(randomId("no_such_whop_course"));
    expect(result.rowCount).toBe(0);

    const projects = await listProjects(pool);
    expect(projects.some((p) => p.name === "MasterMind" && p.projectType === "TRADING_STRATEGIES")).toBe(true);
  });

  it("D: never duplicates or removes lesson/analysis/synthesis rows — the backfill only ever touches courses.project_id", async () => {
    const course = await makeCourse();
    await syncLessons(pool, course.id, [lesson()]);
    const lessonRow = await pool.query<{ id: string }>(`SELECT id FROM lessons WHERE course_id = $1`, [course.id]);
    const lessonId = Number(lessonRow.rows[0].id);
    const job = await createJob(pool, lessonId, randomId("fp"));
    await createLessonAnalysis(pool, analysisInput(lessonId, job.jobId));
    await createSynthesisRun(pool, {
      courseId: course.id,
      sourceAnalysisHash: randomId("hash"),
      sourceAnalysisIds: [],
      model: "gemini-3.8-flash",
      synthesisPromptVersion: "test",
      synthesisSchemaVersion: "test",
      synthesizerVersion: "test",
    });

    const countRows = async (table: string): Promise<number> =>
      Number((await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
    const before = {
      lessons: await countRows("lessons"),
      lessonAnalyses: await countRows("lesson_analyses"),
      synthesisRuns: await countRows("synthesis_runs"),
    };

    await runMasterMindBackfill(MASTERMIND_WHOP_COURSE_ID);

    const after = {
      lessons: await countRows("lessons"),
      lessonAnalyses: await countRows("lesson_analyses"),
      synthesisRuns: await countRows("synthesis_runs"),
    };
    expect(after).toEqual(before);
  });
});
