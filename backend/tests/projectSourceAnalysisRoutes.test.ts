import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Request } from "express";
import {
  createAnalyzeProjectSourceHandler,
  createGetProjectSourceAnalysisHandler,
  createRetryProjectSourceAnalysisHandler,
} from "../src/http/routes/projectSourceAnalysis.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createJob, claimNextEligibleJob, markFailed, getJob } from "../src/db/projectSourceAnalysisJobsRepo.js";
import { computeProjectSourceAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
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

function makeDeps(jobTrigger: JobTrigger = makeJobTrigger()) {
  return { pool, jobTrigger, geminiModel: GEMINI_MODEL };
}

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES"): Promise<{ id: number }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [name, projectType]);
  return { id: Number(result.rows[0].id) };
}

async function makeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  return source;
}

function callAnalyze(projectId: string, sourceId: string, body: Record<string, unknown> = {}, jobTrigger?: JobTrigger) {
  const handler = createAnalyzeProjectSourceHandler(makeDeps(jobTrigger));
  const { res, statusCode, body: resBody } = makeResponse();
  return handler({ params: { projectId, sourceId }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: resBody() as Record<string, unknown> }));
}

function callGetAnalysis(projectId: string, sourceId: string) {
  const handler = createGetProjectSourceAnalysisHandler(makeDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, sourceId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRetry(projectId: string, sourceId: string) {
  const handler = createRetryProjectSourceAnalysisHandler(makeDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, sourceId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("POST /api/projects/:projectId/sources/:sourceId/analyze (Phase 4H-B)", () => {
  it("A: succeeds for a YouTube source in a TRADING_STRATEGIES project, returns 202 with a QUEUED job, and triggers the worker", async () => {
    const project = await makeProject("TRADING_STRATEGIES");
    const source = await makeSource(project.id);
    const jobTrigger = makeJobTrigger();

    const { statusCode, body } = await callAnalyze(String(project.id), String(source.id), {}, jobTrigger);

    expect(statusCode).toBe(202);
    expect((body.job as { status: string }).status).toBe("QUEUED");
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);
  });

  it("B: rejected for a GENERAL_KNOWLEDGE project — deterministic 400, no job created", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const source = await makeSource(project.id);

    const { statusCode, body } = await callAnalyze(String(project.id), String(source.id));

    expect(statusCode).toBe(400);
    expect((body.error as { type: string }).type).toBe("analysis_not_available_for_project_type");
    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(jobCount.rows[0].count)).toBe(0);
  });

  it("C: unknown project returns a deterministic 404", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const { statusCode, body } = await callAnalyze("999999999", String(source.id));
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_source_not_found");
  });

  it("C: unknown source returns a deterministic 404", async () => {
    const project = await makeProject();
    const { statusCode } = await callAnalyze(String(project.id), "999999999");
    expect(statusCode).toBe(404);
  });

  it("D: Project A cannot analyze Project B's source — mismatched ownership returns the SAME deterministic 404 as an unknown source", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const sourceOfB = await makeSource(projectB.id);

    const { statusCode, body } = await callAnalyze(String(projectA.id), String(sourceOfB.id));
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_source_not_found");

    // Never leaks anything about the source in the error response.
    expect(JSON.stringify(body)).not.toContain(sourceOfB.externalId);
  });

  it("G: a repeated Analyze click while a job is already in flight is idempotent — no duplicate job is ever created", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);

    const first = await callAnalyze(String(project.id), String(source.id));
    expect(first.statusCode).toBe(202);
    const firstJobId = (first.body.job as { jobId: string }).jobId;

    const second = await callAnalyze(String(project.id), String(source.id));
    expect(second.statusCode).toBe(202);
    expect(second.body.alreadyQueued).toBe(true);
    expect((second.body.job as { jobId: string }).jobId).toBe(firstJobId);

    const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("I: an unsupported provider is rejected deterministically (defensive — no writer ever creates a non-YOUTUBE source today)", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await pool.query(`UPDATE project_sources SET provider = 'DISCORD' WHERE id = $1`, [source.id]);

    const { statusCode, body } = await callAnalyze(String(project.id), String(source.id));
    expect(statusCode).toBe(400);
    expect((body.error as { type: string }).type).toBe("unsupported_provider");
  });

  it("force=true creates a new job even when a COMPLETED analysis already exists under the current fingerprint", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    const job = await createJob(pool, source.id, fingerprint);
    await claimNextEligibleJob(pool, "worker-a");
    await pool.query(`UPDATE project_source_analysis_jobs SET status = 'COMPLETED', lease_owner = NULL WHERE job_id = $1`, [job.jobId]);
    await pool.query(
      `INSERT INTO project_source_analyses (project_source_id, job_id, status, strategy_found, validated_json, analysis_summary, model, prompt_version, extractor_version, schema_version, analysis_fingerprint, started_at, completed_at)
       VALUES ($1, $2, 'completed', false, '{}', 'summary', $3, 'v2', 'v2', 'v2', $4, now(), now())`,
      [source.id, job.jobId, GEMINI_MODEL, fingerprint],
    );

    const { statusCode, body } = await callAnalyze(String(project.id), String(source.id), { force: true });
    expect(statusCode).toBe(202);
    expect((body.job as { jobId: string }).jobId).not.toBe(job.jobId);
  });
});

describe("GET /api/projects/:projectId/sources/:sourceId/analysis (Phase 4H-B)", () => {
  it("returns null job/analysis for a source that has never been analyzed", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const { statusCode, body } = await callGetAnalysis(String(project.id), String(source.id));
    expect(statusCode).toBe(200);
    expect(body.job).toBeNull();
    expect(body.analysis).toBeNull();
  });

  it("C/D: ownership enforced — a mismatched project/source returns 404", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const sourceOfB = await makeSource(projectB.id);
    const { statusCode } = await callGetAnalysis(String(projectA.id), String(sourceOfB.id));
    expect(statusCode).toBe(404);
  });
});

describe("POST /api/projects/:projectId/sources/:sourceId/retry (Phase 4H-B)", () => {
  it("H: retries the latest FAILED job — same job_id, back to QUEUED", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const job = await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));
    await claimNextEligibleJob(pool, "worker-a");
    await markFailed(pool, job.jobId, "worker-a", "permanent", "Video unavailable.");

    const jobTrigger = makeJobTrigger();
    const handler = createRetryProjectSourceAnalysisHandler(makeDeps(jobTrigger));
    const { res, statusCode, body } = makeResponse();
    await handler({ params: { projectId: String(project.id), sourceId: String(source.id) } } as unknown as Request, res);

    expect(statusCode()).toBe(202);
    expect((body() as { job: { jobId: string; status: string } }).job.jobId).toBe(job.jobId);
    expect((body() as { job: { status: string } }).job.status).toBe("QUEUED");
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

    const row = await getJob(pool, job.jobId);
    expect(row?.status).toBe("QUEUED");
  });

  it("W: retry is refused while the latest job is not FAILED (e.g. still QUEUED) — never creates a duplicate", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await createJob(pool, source.id, computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL }));

    const { statusCode, body } = await callRetry(String(project.id), String(source.id));
    expect(statusCode).toBe(409);
    expect((body.error as { type: string }).type).toBe("not_retryable");

    const countResult = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("retry on a source with no job at all is refused, not a 500", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const { statusCode } = await callRetry(String(project.id), String(source.id));
    expect(statusCode).toBe(409);
  });

  it("C/D: ownership enforced for retry too", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const sourceOfB = await makeSource(projectB.id);
    const { statusCode } = await callRetry(String(projectA.id), String(sourceOfB.id));
    expect(statusCode).toBe(404);
  });
});
