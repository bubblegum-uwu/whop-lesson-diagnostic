import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import { createAnalyzeCollectionHandler, type ProjectSourceAnalysisRouteDeps } from "../src/http/routes/projectSourceAnalysis.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { createJob } from "../src/db/projectSourceAnalysisJobsRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { computeProjectSourceAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query("TRUNCATE project_source_analysis_jobs, project_source_analyses RESTART IDENTITY CASCADE");
});

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

function makeDeps(jobTrigger: JobTrigger = makeJobTrigger()): ProjectSourceAnalysisRouteDeps {
  return { pool, jobTrigger, geminiModel: GEMINI_MODEL };
}

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [randomId("proj"), projectType]);
  return { id: Number(result.rows[0].id) };
}

async function makeCollection(projectId: number) {
  const { collection } = await createSourceCollection(pool, {
    projectId,
    provider: "YOUTUBE",
    externalId: randomId("chan"),
    title: "Test Channel",
    sourceUrl: "https://www.youtube.com/channel/x",
  });
  return collection;
}

async function makeSource(projectId: number, collectionId?: number) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    collectionId: collectionId ?? null,
  });
  return source;
}

async function markAnalyzed(projectSourceId: number) {
  // Uses the REAL fingerprint the route itself computes (not a random one)
  // so this file's "already analyzed" skip-check (findLatestByFingerprint)
  // actually matches — unlike synthesisSetsRoutes.test.ts's own markAnalyzed,
  // which only needs project_source_id-keyed eligibility, never fingerprint
  // matching.
  const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId, geminiModel: GEMINI_MODEL });
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [projectSourceId, fingerprint],
  );
  await createProjectSourceAnalysis(pool, {
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
    analysisFingerprint: fingerprint,
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 10,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
}

function callAnalyzeCollection(projectId: string, collectionId: string, jobTrigger?: JobTrigger) {
  const handler = createAnalyzeCollectionHandler(makeDeps(jobTrigger));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("POST /api/projects/:projectId/collections/:collectionId/analyze (Phase 4L)", () => {
  it("queues every NOT_ANALYZED member and triggers the worker once", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const a = await makeSource(project.id, collection.id);
    const b = await makeSource(project.id, collection.id);
    const jobTrigger = makeJobTrigger();

    const { statusCode, body } = await callAnalyzeCollection(String(project.id), String(collection.id), jobTrigger);
    expect(statusCode).toBe(200);
    expect(body).toEqual({ queued: 2, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 0, failed: 0 });
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

    const jobs = await pool.query<{ project_source_id: string }>(`SELECT project_source_id FROM project_source_analysis_jobs WHERE status = 'QUEUED'`);
    expect(jobs.rows.map((r) => Number(r.project_source_id)).sort()).toEqual([a.id, b.id].sort());
  });

  it("skips a source that already has a usable successful analysis, counting it under alreadyAnalyzed — never re-queues it", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const done = await makeSource(project.id, collection.id);
    await markAnalyzed(done.id);

    const { statusCode, body } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(statusCode).toBe(200);
    expect(body).toEqual({ queued: 0, alreadyAnalyzed: 1, alreadyQueued: 0, processing: 0, failed: 0 });

    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [done.id]);
    expect(Number(jobCount.rows[0].count)).toBe(1); // only the one that made it "analyzed" — never a second
  });

  it("never duplicate-queues a source whose latest job is already QUEUED — counted under alreadyQueued", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const source = await makeSource(project.id, collection.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    await createJob(pool, source.id, fingerprint, false);

    const { body } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(body).toEqual({ queued: 0, alreadyAnalyzed: 0, alreadyQueued: 1, processing: 0, failed: 0 });

    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(jobCount.rows[0].count)).toBe(1);
  });

  it("reports a source currently ANALYZING/VALIDATING under processing, distinct from alreadyQueued", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const source = await makeSource(project.id, collection.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    await pool.query(`INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'ANALYZING')`, [source.id, fingerprint]);

    const { body } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(body).toEqual({ queued: 0, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 1, failed: 0 });
  });

  it("re-queues a source whose latest job is FAILED (existing retry semantics), counted under queued", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const source = await makeSource(project.id, collection.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    await pool.query(`INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status, sanitized_error) VALUES ($1, $2, 'FAILED', 'boom')`, [source.id, fingerprint]);

    const { body } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(body).toEqual({ queued: 1, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 0, failed: 0 });
  });

  it("is idempotent — calling twice in a row never double-queues", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const source = await makeSource(project.id, collection.id);

    await callAnalyzeCollection(String(project.id), String(collection.id));
    const { body: second } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(second).toEqual({ queued: 0, alreadyAnalyzed: 0, alreadyQueued: 1, processing: 0, failed: 0 });

    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(jobCount.rows[0].count)).toBe(1);
  });

  it("rejects a collection belonging to a different project with 404, queues nothing", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const collectionOfB = await makeCollection(projectB.id);
    await makeSource(projectB.id, collectionOfB.id);

    const { statusCode, body } = await callAnalyzeCollection(String(projectA.id), String(collectionOfB.id));
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("collection_not_found");
    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs`);
    expect(Number(jobCount.rows[0].count)).toBe(0);
  });

  it("rejects a GENERAL_KNOWLEDGE project's collection with 400 — never queues Trading Strategies analysis for it", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const collection = await makeCollection(project.id);
    await makeSource(project.id, collection.id);

    const { statusCode, body } = await callAnalyzeCollection(String(project.id), String(collection.id));
    expect(statusCode).toBe(400);
    expect((body.error as { type: string }).type).toBe("analysis_not_available_for_project_type");
  });

  it("never creates or touches any Synthesis Set membership — analyzing a collection is not a selection action", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    await makeSource(project.id, collection.id);

    await callAnalyzeCollection(String(project.id), String(collection.id));

    const memberships = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE project_id = $1`, [project.id]);
    expect(memberships.rows).toEqual([]);
  });

  it("an empty collection queues nothing and returns all-zero counts, no worker trigger", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const jobTrigger = makeJobTrigger();

    const { statusCode, body } = await callAnalyzeCollection(String(project.id), String(collection.id), jobTrigger);
    expect(statusCode).toBe(200);
    expect(body).toEqual({ queued: 0, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 0, failed: 0 });
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });
});
