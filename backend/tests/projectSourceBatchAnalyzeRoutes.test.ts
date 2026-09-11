import { describe, it, expect, vi, afterAll } from "vitest";
import type { Request } from "express";
import { createBatchAnalyzeProjectSourcesHandler, type BatchAnalyzeResultEntry } from "../src/http/routes/projectSourceAnalysis.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { createJob } from "../src/db/projectSourceAnalysisJobsRepo.js";
import { computeProjectSourceAnalysisFingerprint } from "../src/pipeline/fingerprint.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
const GEMINI_MODEL = "gemini-3.8-flash";
afterAll(async () => {
  await pool.end();
});

function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES") {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [randomId("proj"), projectType]);
  return { id: Number(result.rows[0].id) };
}

async function makeYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=x" });
  return source;
}

async function makeDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, { projectId, externalId: randomId("attach"), sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3" });
  return source;
}

function callBatchAnalyze(projectId: string, sourceIds: unknown, jobTrigger: JobTrigger = makeJobTrigger(), force?: boolean) {
  const handler = createBatchAnalyzeProjectSourcesHandler({ pool, jobTrigger, geminiModel: GEMINI_MODEL });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { sourceIds, force } } as unknown as Request, res).then(() => ({
    statusCode: statusCode(),
    body: body() as { results?: BatchAnalyzeResultEntry[]; error?: { type: string } },
  }));
}

describe("POST /api/projects/:projectId/sources/analyze-batch (Phase 4K)", () => {
  it("queues exactly the selected sources, nothing else, triggering the worker once", async () => {
    const project = await makeProject();
    const a = await makeYouTubeSource(project.id);
    const b = await makeDiscordSource(project.id);
    const untouched = await makeYouTubeSource(project.id);
    const jobTrigger = makeJobTrigger();

    const { statusCode, body } = await callBatchAnalyze(String(project.id), [a.id, b.id], jobTrigger);
    expect(statusCode).toBe(202);
    expect(body.results).toEqual([
      { sourceId: a.id, kind: "queued" },
      { sourceId: b.id, kind: "queued" },
    ]);
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

    const untouchedJobs = await pool.query(`SELECT 1 FROM project_source_analysis_jobs WHERE project_source_id = $1`, [untouched.id]);
    expect(untouchedJobs.rows).toEqual([]);
  });

  it("a source already queued is reported already_queued, never creating a second job", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    await createJob(pool, source.id, fingerprint);

    const { body } = await callBatchAnalyze(String(project.id), [source.id]);
    expect(body.results).toEqual([{ sourceId: source.id, kind: "already_queued" }]);

    const jobCount = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(Number(jobCount.rows[0].count)).toBe(1);
  });

  it("a source with an existing completed analysis under the current fingerprint is skipped unless force is set", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    const job = await createJob(pool, source.id, fingerprint);
    await pool.query(`UPDATE project_source_analysis_jobs SET status = 'COMPLETED' WHERE job_id = $1`, [job.jobId]);
    await pool.query(
      `INSERT INTO project_source_analyses (project_source_id, job_id, status, strategy_found, validated_json, analysis_summary, model, prompt_version, extractor_version, schema_version, analysis_fingerprint, started_at, completed_at)
       VALUES ($1, $2, 'no_strategy', false, '{}', 'summary', $3, 'v2', 'v2', 'v2', $4, now(), now())`,
      [source.id, job.jobId, GEMINI_MODEL, fingerprint],
    );

    const { body } = await callBatchAnalyze(String(project.id), [source.id]);
    expect(body.results).toEqual([{ sourceId: source.id, kind: "skipped" }]);
  });

  it("force=true re-queues a source even with an existing completed analysis", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: GEMINI_MODEL });
    const job = await createJob(pool, source.id, fingerprint);
    await pool.query(`UPDATE project_source_analysis_jobs SET status = 'COMPLETED' WHERE job_id = $1`, [job.jobId]);
    await pool.query(
      `INSERT INTO project_source_analyses (project_source_id, job_id, status, strategy_found, validated_json, analysis_summary, model, prompt_version, extractor_version, schema_version, analysis_fingerprint, started_at, completed_at)
       VALUES ($1, $2, 'no_strategy', false, '{}', 'summary', $3, 'v2', 'v2', 'v2', $4, now(), now())`,
      [source.id, job.jobId, GEMINI_MODEL, fingerprint],
    );

    const { body } = await callBatchAnalyze(String(project.id), [source.id], makeJobTrigger(), true);
    expect(body.results).toEqual([{ sourceId: source.id, kind: "queued" }]);
  });

  it("an unknown sourceId is reported not_found, never crashing the batch", async () => {
    const project = await makeProject();
    const real = await makeYouTubeSource(project.id);
    const { body } = await callBatchAnalyze(String(project.id), [999999999, real.id]);
    expect(body.results).toEqual([
      { sourceId: 999999999, kind: "not_found" },
      { sourceId: real.id, kind: "queued" },
    ]);
  });

  it("a source belonging to a different project is reported not_found, never leaking cross-project access", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const sourceOfB = await makeYouTubeSource(projectB.id);
    const { body } = await callBatchAnalyze(String(projectA.id), [sourceOfB.id]);
    expect(body.results).toEqual([{ sourceId: sourceOfB.id, kind: "not_found" }]);
  });

  it("rejected for a GENERAL_KNOWLEDGE project — same deterministic 400 as the single-item route, no jobs created", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const source = await makeYouTubeSource(project.id);
    const { statusCode, body } = await callBatchAnalyze(String(project.id), [source.id]);
    expect(statusCode).toBe(400);
    expect(body.error?.type).toBe("analysis_not_available_for_project_type");
    const jobs = await pool.query(`SELECT 1 FROM project_source_analysis_jobs WHERE project_source_id = $1`, [source.id]);
    expect(jobs.rows).toEqual([]);
  });

  it("never triggers the worker when every entry is skipped/already_queued/not_found (nothing was actually queued)", async () => {
    const project = await makeProject();
    const jobTrigger = makeJobTrigger();
    await callBatchAnalyze(String(project.id), [999999999], jobTrigger);
    expect(jobTrigger.triggerRun).not.toHaveBeenCalled();
  });

  it("rejects an empty sourceIds array with 400", async () => {
    const project = await makeProject();
    const { statusCode } = await callBatchAnalyze(String(project.id), []);
    expect(statusCode).toBe(400);
  });

  it("rejects a batch over the max size", async () => {
    const project = await makeProject();
    const { statusCode } = await callBatchAnalyze(String(project.id), Array.from({ length: 51 }, (_, i) => i + 1));
    expect(statusCode).toBe(400);
  });
});
