import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { upsertCourse } from "../src/db/coursesRepo.js";
import { syncLessons, type SyncLessonInput } from "../src/db/lessonsRepo.js";
import { createLessonAnalysis, type CreateLessonAnalysisInput } from "../src/db/lessonAnalysesRepo.js";
import { createJob } from "../src/db/analysisJobsRepo.js";
import { createSynthesisRun } from "../src/db/synthesisRunsRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createGetProjectSourcesHandler, type ProjectSource } from "../src/http/routes/projectSources.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

interface TestProject {
  id: number;
  name: string;
}

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<TestProject> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`,
    [name, projectType],
  );
  return { id: Number(result.rows[0].id), name };
}

async function makeCourse(projectId?: number, overrides: Partial<{ title: string }> = {}) {
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
    estimatedCost: 0.01,
    ...overrides,
  };
}

async function callHandler(projectId: string) {
  const handler = createGetProjectSourcesHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as { projectId?: number; sources?: ProjectSource[]; error?: { type: string } } };
}

describe("GET /api/projects/:projectId/sources", () => {
  it("A: an authenticated request for a real project succeeds", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callHandler(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.projectId).toBe(project.id);
    expect(body.sources).toEqual([]);
  });

  it("B/C/D: returns the project's connected Whop course with correct lesson and analyzed counts", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id, { title: "The Trading Accelerator" });
    await syncLessons(pool, course.id, [lesson(), lesson(), lesson()]);
    const lessonRows = await pool.query<{ id: string }>(`SELECT id FROM lessons WHERE course_id = $1 ORDER BY id`, [course.id]);
    const lessonIds = lessonRows.rows.map((r) => Number(r.id));

    const job = await createJob(pool, lessonIds[0], randomId("fp"));
    await createLessonAnalysis(pool, analysisInput(lessonIds[0], job.jobId));
    // getSummaryCounts (same helper analysisSummary.ts uses) counts by
    // analysis_jobs.status, not by the presence of a lesson_analyses row —
    // set it directly rather than racing the global job-claim queue.
    await pool.query(`UPDATE analysis_jobs SET status = 'COMPLETED' WHERE job_id = $1`, [job.jobId]);

    const { statusCode, body } = await callHandler(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.sources).toHaveLength(1);
    const source = body.sources![0];
    expect(source.provider).toBe("WHOP");
    expect(source.sourceType).toBe("COURSE");
    expect(source.name).toBe("The Trading Accelerator");
    expect(source.externalId).toBe(course.whopCourseId);
    expect(source.courseId).toBe(course.id);
    expect(source.lessonCount).toBe(3);
    expect(source.analyzedLessonCount).toBe(1);
    expect(source.remainingCount).toBe(2);
    expect(source.totalCost).toBeCloseTo(0.01, 5);
  });

  it("E/K: an unrelated project's course is never returned — sources are scoped by courses.project_id", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await makeCourse(projectA.id, { title: "Project A's Course" });
    await makeCourse(projectB.id, { title: "Project B's Course" });

    const { body: bodyA } = await callHandler(String(projectA.id));
    const { body: bodyB } = await callHandler(String(projectB.id));

    expect(bodyA.sources).toHaveLength(1);
    expect(bodyA.sources![0].name).toBe("Project A's Course");
    expect(bodyB.sources).toHaveLength(1);
    expect(bodyB.sources![0].name).toBe("Project B's Course");
  });

  it("F: a known project with zero courses returns 200 with an empty sources array", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { statusCode, body } = await callHandler(String(project.id));
    expect(statusCode).toBe(200);
    expect(body.sources).toEqual([]);
  });

  it("G: an unknown project returns a deterministic 404", async () => {
    const { statusCode, body } = await callHandler("999999999");
    expect(statusCode).toBe(404);
    expect(body.error?.type).toBe("project_not_found");
  });

  it("G: a non-numeric projectId returns 404 rather than 500ing", async () => {
    const { statusCode, body } = await callHandler("mastermind");
    expect(statusCode).toBe(404);
    expect(body.error?.type).toBe("project_not_found");
  });

  it("I: never returns duplicate sources across repeated calls", async () => {
    const project = await makeProject();
    await makeCourse(project.id);

    const first = await callHandler(String(project.id));
    const second = await callHandler(String(project.id));
    expect(first.body.sources).toHaveLength(1);
    expect(second.body.sources).toHaveLength(1);
  });

  it("J: is read-only — never modifies lesson/analysis/synthesis rows", async () => {
    const project = await makeProject();
    const course = await makeCourse(project.id);
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

    await callHandler(String(project.id));

    const after = {
      lessons: await countRows("lessons"),
      lessonAnalyses: await countRows("lesson_analyses"),
      synthesisRuns: await countRows("synthesis_runs"),
    };
    expect(after).toEqual(before);
  });
});
