import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  createListSynthesisSetsHandler,
  createCreateSynthesisSetHandler,
  createGetSynthesisSetHandler,
  createUpdateSynthesisSetHandler,
  createDeleteSynthesisSetHandler,
  createAddSourceToSynthesisSetHandler,
  createRemoveSourceFromSynthesisSetHandler,
  type SynthesisSetsRouteDeps,
} from "../src/http/routes/synthesisSets.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

function deps(): SynthesisSetsRouteDeps {
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

async function makeDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, { projectId, externalId: randomId("attach"), sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3" });
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

async function jobAndAnalysisCounts(projectSourceId: number) {
  const jobs = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`, [projectSourceId]);
  const analyses = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM project_source_analyses WHERE project_source_id = $1`, [projectSourceId]);
  return { jobs: Number(jobs.rows[0].count), analyses: Number(analyses.rows[0].count) };
}

function callList(projectId: string) {
  const handler = createListSynthesisSetsHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callCreate(projectId: string, body: Record<string, unknown>) {
  const handler = createCreateSynthesisSetHandler(deps());
  const { res, statusCode, body: resBody } = makeResponse();
  return handler({ params: { projectId }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: resBody() as Record<string, unknown> }));
}

function callGet(projectId: string, setId: string) {
  const handler = createGetSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callUpdate(projectId: string, setId: string, body: Record<string, unknown>) {
  const handler = createUpdateSynthesisSetHandler(deps());
  const { res, statusCode, body: resBody } = makeResponse();
  return handler({ params: { projectId, setId }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: resBody() as Record<string, unknown> }));
}

function callDelete(projectId: string, setId: string) {
  const handler = createDeleteSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> | undefined }));
}

function callAddSource(projectId: string, setId: string, body: Record<string, unknown>) {
  const handler = createAddSourceToSynthesisSetHandler(deps());
  const { res, statusCode, body: resBody } = makeResponse();
  return handler({ params: { projectId, setId }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: resBody() as Record<string, unknown> }));
}

function callRemoveSource(projectId: string, setId: string, sourceId: string) {
  const handler = createRemoveSourceFromSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId, sourceId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> | undefined }));
}

describe("Synthesis Sets CRUD routes (Phase 4J)", () => {
  it("creates a set with 201, defaults to empty readiness", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callCreate(String(project.id), { name: "Scalping Playbook", description: "notes" });
    expect(statusCode).toBe(201);
    expect(body.name).toBe("Scalping Playbook");
    expect(body.sourceCount).toBe(0);
    expect(body.analyzedSourceCount).toBe(0);
    expect(body.needsAnalysisCount).toBe(0);
  });

  it("rejects an empty/whitespace name with 400, creates no row", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callCreate(String(project.id), { name: "   " });
    expect(statusCode).toBe(400);
    expect((body.error as { type: string }).type).toBe("invalid_request");
    const { statusCode: listStatus, body: listBody } = await callList(String(project.id));
    expect(listStatus).toBe(200);
    expect(listBody.synthesisSets).toEqual([]);
  });

  it("create against an unknown project returns 404", async () => {
    const { statusCode } = await callCreate("999999999", { name: "x" });
    expect(statusCode).toBe(404);
  });

  it("lists sets for a project with readiness rollups, never leaking another project's sets", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await callCreate(String(projectA.id), { name: "A-set" });
    await callCreate(String(projectB.id), { name: "B-set" });

    const { body } = await callList(String(projectA.id));
    const sets = body.synthesisSets as Array<{ name: string }>;
    expect(sets.map((s) => s.name)).toEqual(["A-set"]);
  });

  it("gets set detail including member sources with per-source analyzed flags", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await markAnalyzed(source.id);
    const unanalyzed = await makeDiscordSource(project.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);
    await callAddSource(String(project.id), setId, { sourceId: source.id });
    await callAddSource(String(project.id), setId, { sourceId: unanalyzed.id });

    const { statusCode, body } = await callGet(String(project.id), setId);
    expect(statusCode).toBe(200);
    expect(body.sourceCount).toBe(2);
    expect(body.analyzedSourceCount).toBe(1);
    expect(body.needsAnalysisCount).toBe(1);
    const sources = body.sources as Array<{ id: number; analyzed: boolean }>;
    expect(sources.find((s) => s.id === source.id)?.analyzed).toBe(true);
    expect(sources.find((s) => s.id === unanalyzed.id)?.analyzed).toBe(false);
  });

  it("get/update/delete against a mismatched project returns the same deterministic 404 as an unknown set", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const { body: created } = await callCreate(String(projectB.id), { name: "B-set" });
    const setId = String(created.id);

    const getResult = await callGet(String(projectA.id), setId);
    expect(getResult.statusCode).toBe(404);
    expect((getResult.body.error as { type: string }).type).toBe("synthesis_set_not_found");

    const updateResult = await callUpdate(String(projectA.id), setId, { name: "hijacked" });
    expect(updateResult.statusCode).toBe(404);

    const deleteResult = await callDelete(String(projectA.id), setId);
    expect(deleteResult.statusCode).toBe(404);
  });

  it("renames a set (name only), leaving description untouched", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "old", description: "keep" });
    const { statusCode, body } = await callUpdate(String(project.id), String(created.id), { name: "new" });
    expect(statusCode).toBe(200);
    expect(body.name).toBe("new");
    expect(body.description).toBe("keep");
  });

  it("rejects renaming to an empty name with 400", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "old" });
    const { statusCode } = await callUpdate(String(project.id), String(created.id), { name: "  " });
    expect(statusCode).toBe(400);
  });

  it("deletes a set with 204; a subsequent get is 404", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "gone soon" });
    const setId = String(created.id);

    const { statusCode } = await callDelete(String(project.id), setId);
    expect(statusCode).toBe(204);

    const getResult = await callGet(String(project.id), setId);
    expect(getResult.statusCode).toBe(404);
  });
});

describe("Synthesis Set membership routes (Phase 4J)", () => {
  it("adds a source with 201 on first add, 200 (added: false) on a repeated add — idempotent, never a duplicate row", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);

    const first = await callAddSource(String(project.id), setId, { sourceId: source.id });
    expect(first.statusCode).toBe(201);
    expect(first.body.added).toBe(true);

    const second = await callAddSource(String(project.id), setId, { sourceId: source.id });
    expect(second.statusCode).toBe(200);
    expect(second.body.added).toBe(false);

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
      [created.id, source.id],
    );
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("rejects adding a source from a different project — 404, never attaches cross-project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const sourceOfB = await makeYouTubeSource(projectB.id);
    const { body: created } = await callCreate(String(projectA.id), { name: "A-set" });

    const { statusCode, body } = await callAddSource(String(projectA.id), String(created.id), { sourceId: sourceOfB.id });
    expect(statusCode).toBe(404);
    expect((body.error as { type: string }).type).toBe("project_source_not_found");

    expect(await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE synthesis_set_id = $1`, [created.id]).then((r) => r.rows)).toEqual([]);
  });

  it("rejects adding an unknown sourceId with 404", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const { statusCode } = await callAddSource(String(project.id), String(created.id), { sourceId: 999999999 });
    expect(statusCode).toBe(404);
  });

  it("removes a source with 204; membership is gone but source/analysis remain", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await markAnalyzed(source.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);
    await callAddSource(String(project.id), setId, { sourceId: source.id });

    const { statusCode } = await callRemoveSource(String(project.id), setId, String(source.id));
    expect(statusCode).toBe(204);

    const { body: detail } = await callGet(String(project.id), setId);
    expect(detail.sourceCount).toBe(0);
    const counts = await jobAndAnalysisCounts(source.id);
    expect(counts.jobs).toBe(1);
    expect(counts.analyses).toBe(1);
  });

  it("CRITICAL: a source in two sets — removing from one leaves it in the other; deleting one set leaves the source and the other set untouched", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    const { body: setA } = await callCreate(String(project.id), { name: "Set A" });
    const { body: setB } = await callCreate(String(project.id), { name: "Set B" });

    await callAddSource(String(project.id), String(setA.id), { sourceId: source.id });
    await callAddSource(String(project.id), String(setB.id), { sourceId: source.id });

    let detailA = (await callGet(String(project.id), String(setA.id))).body;
    let detailB = (await callGet(String(project.id), String(setB.id))).body;
    expect(detailA.sourceCount).toBe(1);
    expect(detailB.sourceCount).toBe(1);

    await callRemoveSource(String(project.id), String(setA.id), String(source.id));
    detailA = (await callGet(String(project.id), String(setA.id))).body;
    detailB = (await callGet(String(project.id), String(setB.id))).body;
    expect(detailA.sourceCount).toBe(0);
    expect(detailB.sourceCount).toBe(1);
    expect((detailB.sources as Array<{ id: number }>).map((s) => s.id)).toEqual([source.id]);

    await callDelete(String(project.id), String(setB.id));
    const sourceStillExists = await pool.query(`SELECT id FROM project_sources WHERE id = $1`, [source.id]);
    expect(sourceStillExists.rows).toHaveLength(1);
    const setAStillExists = await callGet(String(project.id), String(setA.id));
    expect(setAStillExists.statusCode).toBe(200);
  });
});

describe("Analysis independence (Phase 4J, section 32) — YouTube and Discord", () => {
  for (const [label, makeSource] of [
    ["YouTube", makeYouTubeSource],
    ["Discord", makeDiscordSource],
  ] as const) {
    it(`${label}: creating a set does not touch any source's jobs/analyses`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      await callCreate(String(project.id), { name: "s" });
      const counts = await jobAndAnalysisCounts(source.id);
      expect(counts).toEqual({ jobs: 0, analyses: 0 });
    });

    it(`${label}: adding a source to a set never creates a job or an analysis`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const { body: created } = await callCreate(String(project.id), { name: "s" });
      await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

      const counts = await jobAndAnalysisCounts(source.id);
      expect(counts).toEqual({ jobs: 0, analyses: 0 });
      const sourceRow = await pool.query<{ status: string }>(`SELECT status FROM project_sources WHERE id = $1`, [source.id]);
      expect(sourceRow.rows[0].status).toBe("READY");
    });

    it(`${label}: removing a source from a set never deletes its analysis`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      await markAnalyzed(source.id);
      const { body: created } = await callCreate(String(project.id), { name: "s" });
      await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

      await callRemoveSource(String(project.id), String(created.id), String(source.id));

      const counts = await jobAndAnalysisCounts(source.id);
      expect(counts).toEqual({ jobs: 1, analyses: 1 });
    });

    it(`${label}: analyzing a source (marking it analyzed) never adds it to any synthesis set`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      await callCreate(String(project.id), { name: "unrelated set" });
      await markAnalyzed(source.id);

      const memberships = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE project_source_id = $1`, [source.id]);
      expect(memberships.rows).toEqual([]);
    });

    it(`${label}: re-analyzing a member source does not change its set memberships`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const { body: created } = await callCreate(String(project.id), { name: "s" });
      await callAddSource(String(project.id), String(created.id), { sourceId: source.id });
      await markAnalyzed(source.id);
      await markAnalyzed(source.id);

      const { body: detail } = await callGet(String(project.id), String(created.id));
      expect(detail.sourceCount).toBe(1);
      const membershipCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
        [created.id, source.id],
      );
      expect(Number(membershipCount.rows[0].count)).toBe(1);
    });

    it(`${label}: a FAILED analysis job does not remove existing set memberships`, async () => {
      const project = await makeProject();
      const source = await makeSource(project.id);
      const { body: created } = await callCreate(String(project.id), { name: "s" });
      await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

      await pool.query(
        `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status, sanitized_error) VALUES ($1, $2, 'FAILED', 'boom')`,
        [source.id, randomId("fp")],
      );

      const { body: detail } = await callGet(String(project.id), String(created.id));
      expect(detail.sourceCount).toBe(1);
      expect(detail.analyzedSourceCount).toBe(0);
      expect(detail.needsAnalysisCount).toBe(1);
    });
  }

  it("all four source states are visible without being silently dropped: member+analyzed, member+not-analyzed, non-member+analyzed, non-member+not-analyzed", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);

    const memberAnalyzed = await makeYouTubeSource(project.id);
    await markAnalyzed(memberAnalyzed.id);
    await callAddSource(String(project.id), setId, { sourceId: memberAnalyzed.id });

    const memberUnanalyzed = await makeDiscordSource(project.id);
    await callAddSource(String(project.id), setId, { sourceId: memberUnanalyzed.id });

    const nonMemberAnalyzed = await makeYouTubeSource(project.id);
    await markAnalyzed(nonMemberAnalyzed.id);

    const nonMemberUnanalyzed = await makeDiscordSource(project.id);
    void nonMemberUnanalyzed;

    const { body: detail } = await callGet(String(project.id), setId);
    expect(detail.sourceCount).toBe(2);
    expect(detail.analyzedSourceCount).toBe(1);
    expect(detail.needsAnalysisCount).toBe(1);
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id).sort((a, b) => a - b);
    expect(memberIds.sort((a, b) => a - b)).toEqual([memberAnalyzed.id, memberUnanalyzed.id].sort((a, b) => a - b));
    expect(memberIds).not.toContain(nonMemberAnalyzed.id);
  });
});
