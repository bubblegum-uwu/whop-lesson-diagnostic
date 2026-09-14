import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  createCreateSynthesisSetHandler,
  createGetSynthesisSetHandler,
  createAddSourceToSynthesisSetHandler,
  createRemoveSourceFromSynthesisSetHandler,
  createBulkUpdateSynthesisSetSourcesHandler,
  createBulkAddCollectionToSynthesisSetHandler,
  createBulkRemoveCollectionFromSynthesisSetHandler,
  type SynthesisSetsRouteDeps,
} from "../src/http/routes/synthesisSets.js";
import { createYouTubeSource, createDiscordSource, deleteProjectSource } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
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

async function makeYouTubeSource(projectId: number, collectionId?: number) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0"),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    collectionId: collectionId ?? null,
  });
  return source;
}

async function makeDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, {
    ownerIdentity: "test-identity",
    projectId,
    externalId: randomId("attach"),
    sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3",
  });
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

function callBulkSources(projectId: string, setId: string, body: Record<string, unknown>) {
  const handler = createBulkUpdateSynthesisSetSourcesHandler(deps());
  const { res, statusCode, body: resBody } = makeResponse();
  return handler({ params: { projectId, setId }, body } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: resBody() as Record<string, unknown> }));
}

function callBulkAddCollection(projectId: string, setId: string, collectionId: string) {
  const handler = createBulkAddCollectionToSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkRemoveCollection(projectId: string, setId: string, collectionId: string) {
  const handler = createBulkRemoveCollectionFromSynthesisSetHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("Synthesis Set collection-centric bulk selection (Phase 4L)", () => {
  it("bulk-adds only the currently-eligible members of a collection, reporting eligible/already-selected/added/ineligible counts", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzedA = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzedA.id);
    const analyzedB = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzedB.id);
    const unanalyzed = await makeYouTubeSource(project.id, collection.id);
    void unanalyzed;
    const { body: created } = await callCreate(String(project.id), { name: "Core Strategy" });
    const setId = String(created.id);

    const { statusCode, body } = await callBulkAddCollection(String(project.id), setId, String(collection.id));
    expect(statusCode).toBe(200);
    expect(body).toEqual({ collectionId: String(collection.id), eligibleCount: 2, alreadySelectedCount: 0, addedCount: 2, ineligibleCount: 1 });

    const { body: detail } = await callGet(String(project.id), setId);
    expect(detail.sourceCount).toBe(2);
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id).sort((a, b) => a - b);
    expect(memberIds).toEqual([analyzedA.id, analyzedB.id].sort((a, b) => a - b));
  });

  it("is idempotent: bulk-adding the same collection twice reports the second call's eligible sources as already-selected, adds nothing new", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzed = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzed.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);

    await callBulkAddCollection(String(project.id), setId, String(collection.id));
    const { body: second } = await callBulkAddCollection(String(project.id), setId, String(collection.id));
    expect(second).toEqual({ collectionId: String(collection.id), eligibleCount: 1, alreadySelectedCount: 1, addedCount: 0, ineligibleCount: 0 });

    const membershipCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
      [created.id, analyzed.id],
    );
    expect(Number(membershipCount.rows[0].count)).toBe(1);
  });

  it("SNAPSHOT invariant: a source imported into an already-bulk-selected collection afterward is never auto-selected", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzed = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzed.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);
    await callBulkAddCollection(String(project.id), setId, String(collection.id));

    // A new source is imported into the SAME collection after the bulk-select snapshot.
    const lateArrival = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(lateArrival.id);

    const { body: detail } = await callGet(String(project.id), setId);
    expect(detail.sourceCount).toBe(1);
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id);
    expect(memberIds).not.toContain(lateArrival.id);
  });

  it("SNAPSHOT invariant: a member of the collection that becomes analyzed AFTER the snapshot is never auto-added", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzed = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzed.id);
    const notYetAnalyzed = await makeYouTubeSource(project.id, collection.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const setId = String(created.id);
    await callBulkAddCollection(String(project.id), setId, String(collection.id));

    await markAnalyzed(notYetAnalyzed.id); // becomes eligible only AFTER the snapshot

    const { body: detail } = await callGet(String(project.id), setId);
    expect(detail.sourceCount).toBe(1);
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id);
    expect(memberIds).not.toContain(notYetAnalyzed.id);
  });

  it("rejects bulk-add for a collection belonging to a different project — 404, adds nothing", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const collectionOfB = await makeCollection(projectB.id);
    const { body: created } = await callCreate(String(projectA.id), { name: "A-set" });

    const { statusCode } = await callBulkAddCollection(String(projectA.id), String(created.id), String(collectionOfB.id));
    expect(statusCode).toBe(404);
    const memberships = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE synthesis_set_id = $1`, [created.id]);
    expect(memberships.rows).toEqual([]);
  });

  it("rejects bulk-add for an unknown collection id with 404", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const { statusCode } = await callBulkAddCollection(String(project.id), String(created.id), "999999999");
    expect(statusCode).toBe(404);
  });

  it("bulk-removes only this collection's sources from THIS set, never another set, and never the sources/analyses themselves", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzed = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzed.id);
    const outsideSource = await makeYouTubeSource(project.id);
    await markAnalyzed(outsideSource.id);

    const { body: setA } = await callCreate(String(project.id), { name: "Set A" });
    const { body: setB } = await callCreate(String(project.id), { name: "Set B" });
    await callBulkAddCollection(String(project.id), String(setA.id), String(collection.id));
    await callAddSource(String(project.id), String(setA.id), { sourceId: outsideSource.id });
    await callBulkAddCollection(String(project.id), String(setB.id), String(collection.id));

    const { statusCode, body } = await callBulkRemoveCollection(String(project.id), String(setA.id), String(collection.id));
    expect(statusCode).toBe(200);
    expect(body).toEqual({ collectionId: String(collection.id), removedCount: 1 });

    const detailA = (await callGet(String(project.id), String(setA.id))).body;
    expect((detailA.sources as Array<{ id: number }>).map((s) => s.id)).toEqual([outsideSource.id]);
    const detailB = (await callGet(String(project.id), String(setB.id))).body;
    expect(detailB.sourceCount).toBe(1);

    const sourceStillExists = await pool.query(`SELECT id FROM project_sources WHERE id = $1`, [analyzed.id]);
    expect(sourceStillExists.rows).toHaveLength(1);
  });

  it("bulk-remove-collection is idempotent — a second call removes nothing further", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const analyzed = await makeYouTubeSource(project.id, collection.id);
    await markAnalyzed(analyzed.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    await callBulkAddCollection(String(project.id), String(created.id), String(collection.id));

    await callBulkRemoveCollection(String(project.id), String(created.id), String(collection.id));
    const { statusCode, body } = await callBulkRemoveCollection(String(project.id), String(created.id), String(collection.id));
    expect(statusCode).toBe(200);
    expect(body.removedCount).toBe(0);
  });

  it("bulk sources add: skips ineligible/foreign ids without erroring, reports ineligibleSkippedCount, adds only the eligible ones", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const eligible = await makeYouTubeSource(projectA.id);
    await markAnalyzed(eligible.id);
    const notAnalyzed = await makeDiscordSource(projectA.id);
    const foreign = await makeYouTubeSource(projectB.id);
    await markAnalyzed(foreign.id);
    const { body: created } = await callCreate(String(projectA.id), { name: "s" });

    const { statusCode, body } = await callBulkSources(String(projectA.id), String(created.id), {
      add: [eligible.id, notAnalyzed.id, foreign.id],
    });
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(1);
    expect(body.ineligibleSkippedCount).toBe(2);

    const { body: detail } = await callGet(String(projectA.id), String(created.id));
    expect((detail.sources as Array<{ id: number }>).map((s) => s.id)).toEqual([eligible.id]);
  });

  it("bulk sources remove: removes the requested ids from this set only, safe (idempotent) on ids that are already absent", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await markAnalyzed(source.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

    const { statusCode, body } = await callBulkSources(String(project.id), String(created.id), { remove: [source.id, 999999999] });
    expect(statusCode).toBe(200);
    expect(body.removedCount).toBe(1);

    const { body: detail } = await callGet(String(project.id), String(created.id));
    expect(detail.sourceCount).toBe(0);
  });

  it("rejects a non-array add/remove body with 400", async () => {
    const project = await makeProject();
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    const { statusCode } = await callBulkSources(String(project.id), String(created.id), { add: "not-an-array" });
    expect(statusCode).toBe(400);
  });

  it("removing an already-removed single source is a safe no-op (204, never errors)", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await markAnalyzed(source.id);
    const { body: created } = await callCreate(String(project.id), { name: "s" });
    await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

    await callRemoveSource(String(project.id), String(created.id), String(source.id));
    const { statusCode } = await callRemoveSource(String(project.id), String(created.id), String(source.id));
    expect(statusCode).toBe(204);
  });

  it("CASCADE: deleting a project_source removes its Synthesis Set membership but never the set itself", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSource(project.id);
    await markAnalyzed(source.id);
    const { body: created } = await callCreate(String(project.id), { name: "Keep me" });
    await callAddSource(String(project.id), String(created.id), { sourceId: source.id });

    await deleteProjectSource(pool, source.id);

    const membership = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE synthesis_set_id = $1`, [created.id]);
    expect(membership.rows).toEqual([]);
    const { statusCode, body } = await callGet(String(project.id), String(created.id));
    expect(statusCode).toBe(200);
    expect(body.name).toBe("Keep me");
    expect(body.sourceCount).toBe(0);
  });
});
