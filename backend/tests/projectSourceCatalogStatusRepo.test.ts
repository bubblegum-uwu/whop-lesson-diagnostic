import { describe, it, expect, afterAll } from "vitest";
import { getCatalogAnalysisStatusForSources } from "../src/db/projectSourceCatalogStatusRepo.js";
import { createYouTubeSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=x" });
  return source;
}

async function markAnalyzed(projectSourceId: number) {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [projectSourceId, randomId("fp")],
  );
  await createProjectSourceAnalysis(pool, {
    projectSourceId,
    jobId: jobResult.rows[0].job_id,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "No strategy found.",
    model: "gemini-3.8-flash",
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

describe("getCatalogAnalysisStatusForSources", () => {
  it("returns an empty map for an empty input, without querying", async () => {
    expect(await getCatalogAnalysisStatusForSources(pool, [])).toEqual(new Map());
  });

  it("NOT_ANALYZED for a source that has never had a job", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    const result = await getCatalogAnalysisStatusForSources(pool, [source.id]);
    expect(result.get(source.id)).toEqual({ status: "NOT_ANALYZED", eligibleForSynthesis: false });
  });

  it("ANALYZED + eligible for a source with a completed/no_strategy analysis", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await markAnalyzed(source.id);
    const result = await getCatalogAnalysisStatusForSources(pool, [source.id]);
    expect(result.get(source.id)).toEqual({ status: "ANALYZED", eligibleForSynthesis: true });
  });

  it("QUEUED/ANALYZING/FAILED reflect the latest job status when there is no usable analysis yet", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await pool.query(`INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'FAILED')`, [source.id, randomId("fp")]);
    const result = await getCatalogAnalysisStatusForSources(pool, [source.id]);
    expect(result.get(source.id)).toEqual({ status: "FAILED", eligibleForSynthesis: false });
  });

  it("a source with a FAILED job followed by a later COMPLETED analysis is ANALYZED — not stuck on the older failure", async () => {
    const project = await makeProject();
    const source = await makeSource(project.id);
    await pool.query(`INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'FAILED')`, [source.id, randomId("fp")]);
    await markAnalyzed(source.id);
    const result = await getCatalogAnalysisStatusForSources(pool, [source.id]);
    expect(result.get(source.id)?.status).toBe("ANALYZED");
  });

  it("batches correctly across many sources in one call, never N+1", async () => {
    const project = await makeProject();
    const analyzed = await makeSource(project.id);
    await markAnalyzed(analyzed.id);
    const notAnalyzed = await makeSource(project.id);

    const result = await getCatalogAnalysisStatusForSources(pool, [analyzed.id, notAnalyzed.id]);
    expect(result.size).toBe(2);
    expect(result.get(analyzed.id)?.status).toBe("ANALYZED");
    expect(result.get(notAnalyzed.id)?.status).toBe("NOT_ANALYZED");
  });
});
