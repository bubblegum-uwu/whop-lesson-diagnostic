import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { createAddProjectSourceToProjectsHandler, type AddToProjectResponse } from "../src/http/routes/projectSources.js";
import { createDiscordSource, createYouTubeSource, deleteProjectSource, getProjectSourceById, listProjectSourcesByProjectId } from "../src/db/projectSourcesRepo.js";
import { getContentAssetById, getContentAssetMedia, saveContentAssetMedia } from "../src/db/contentAssetsRepo.js";
import { createSourceCollection, listSourceCollectionsByProjectId } from "../src/db/sourceCollectionsRepo.js";
import { createJob } from "../src/db/projectSourceAnalysisJobsRepo.js";
import { createProjectSourceAnalysis, getLatestByProjectSource } from "../src/db/projectSourceAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "GENERAL_KNOWLEDGE"): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`, [randomId("proj"), projectType]);
  return { id: Number(result.rows[0].id) };
}

async function makeDiscordSourceIn(projectId: number, ownerIdentity: string, overrides: Partial<{ externalId: string; collectionId: number | null }> = {}) {
  const externalId = overrides.externalId ?? randomSnowflake();
  const { source } = await createDiscordSource(pool, {
    projectId,
    ownerIdentity,
    externalId,
    sourceUrl: `https://cdn.discordapp.com/attachments/1/${externalId}/clip.mp4`,
    collectionId: overrides.collectionId ?? null,
  });
  // A genuinely captured source always has durable media by the time it
  // exists as a project_source (see createAddDiscordSourceHandler/
  // worker/discordCaptureLoop.ts) — this test helper mirrors that so
  // Add-to-Project's "never duplicates media" assertions are meaningful.
  await saveContentAssetMedia(pool, { contentAssetId: source.contentAssetId!, content: Buffer.from("fake-video-bytes"), contentType: "video/mp4", byteSize: 16 });
  return source;
}

function callHandler(projectId: number, sourceId: number, knoveraOperator: string, targetProjectIds: unknown) {
  const handler = createAddProjectSourceToProjectsHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  const req = { params: { projectId: String(projectId), sourceId: String(sourceId) }, body: { targetProjectIds }, knoveraOperator } as unknown as Request;
  return handler(req, res).then(() => ({ statusCode: statusCode(), body: body() as AddToProjectResponse & { error?: { type: string; message: string } } }));
}

describe("POST /api/projects/:projectId/sources/:sourceId/add-to-projects", () => {
  it("A: adds an already-captured Discord source to a single other project, leaving the original untouched", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [target.id]);

    expect(statusCode).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ projectId: target.id, kind: "added" });

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1);
    expect(targetSources[0].contentAssetId).toBe(source.contentAssetId);

    // Original stays exactly where it was — this is copy/reference, never move.
    const originStillThere = await getProjectSourceById(pool, source.id);
    expect(originStillThere).not.toBeNull();
    expect(originStillThere?.projectId).toBe(origin.id);
  });

  it("B: adds to multiple authorized projects in one call, one result per target", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const targetA = await makeProject("TRADING_STRATEGIES");
    const targetB = await makeProject("GENERAL_KNOWLEDGE");
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [targetA.id, targetB.id]);

    expect(statusCode).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results.find((r) => r.projectId === targetA.id)?.kind).toBe("added");
    expect(body.results.find((r) => r.projectId === targetB.id)?.kind).toBe("added");
  });

  it("C: a duplicate target within one request is idempotent — added once, already_present the second time", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [target.id, target.id]);

    expect(statusCode).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].kind).toBe("added");
    expect(body.results[1].kind).toBe("already_present");

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1);
  });

  it("D: destination project type is never restricted — cross-project-type add succeeds", async () => {
    const identity = randomId("identity");
    const origin = await makeProject("GENERAL_KNOWLEDGE");
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [target.id]);

    expect(statusCode).toBe(200);
    expect(body.results[0].kind).toBe("added");
  });

  it("E: a mismatched identity (does not own the underlying content asset) gets 'unauthorized' for every target — cross-identity isolation", async () => {
    const ownerIdentity = randomId("identity-a");
    const attackerIdentity = randomId("identity-b");
    const origin = await makeProject();
    const targetA = await makeProject();
    const targetB = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, ownerIdentity);

    const { statusCode, body } = await callHandler(origin.id, source.id, attackerIdentity, [targetA.id, targetB.id]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([
      { projectId: targetA.id, kind: "unauthorized" },
      { projectId: targetB.id, kind: "unauthorized" },
    ]);

    expect(await listProjectSourcesByProjectId(pool, targetA.id)).toHaveLength(0);
    expect(await listProjectSourcesByProjectId(pool, targetB.id)).toHaveLength(0);
  });

  it("F: an unknown target project id comes back invalid", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [999999999]);

    expect(statusCode).toBe(200);
    expect(body.results).toEqual([{ projectId: 999999999, kind: "invalid" }]);
  });

  it("G: adding to the SAME project the source is already in is a no-op already_present, never a duplicate row", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [origin.id]);

    expect(statusCode).toBe(200);
    expect(body.results[0]).toMatchObject({ projectId: origin.id, kind: "already_present" });
    expect(await listProjectSourcesByProjectId(pool, origin.id)).toHaveLength(1);
  });

  it("H: a since-deleted target project comes back invalid, not a crash", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);
    const deletedTarget = await makeProject();
    await pool.query(`DELETE FROM projects WHERE id = $1`, [deletedTarget.id]);

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [deletedTarget.id]);

    expect(statusCode).toBe(200);
    expect(body.results[0]).toEqual({ projectId: deletedTarget.id, kind: "invalid" });
  });

  it("I: adding an already-present source again (a second, separate request) is idempotent — one asset, one media row, one project_source", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);

    const first = await callHandler(origin.id, source.id, identity, [target.id]);
    expect(first.body.results[0].kind).toBe("added");

    const second = await callHandler(origin.id, source.id, identity, [target.id]);
    expect(second.body.results[0].kind).toBe("already_present");

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1);
  });

  it("J: sharing a non-Discord (YouTube) source is rejected — the shared-asset model is Discord-only in this phase", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject();
    const { source } = await createYouTubeSource(pool, { projectId: origin.id, externalId: randomId("yt"), sourceUrl: "https://www.youtube.com/watch?v=abc" });

    const { statusCode, body } = await callHandler(origin.id, source.id, identity, [target.id]);

    expect(statusCode).toBe(400);
    expect(body.error?.type).toBe("source_not_shareable");
  });

  it("K: never duplicates the durable media and never creates an analysis job for the destination — capture ≠ add-to-project ≠ analysis", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject();
    const source = await makeDiscordSourceIn(origin.id, identity);

    await callHandler(origin.id, source.id, identity, [target.id]);

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources[0].contentAssetId).toBe(source.contentAssetId);

    // Exactly one media row for this asset — never duplicated per project_source.
    const mediaRows = await pool.query(`SELECT COUNT(*)::int AS count FROM content_asset_media WHERE content_asset_id = $1`, [source.contentAssetId]);
    expect(mediaRows.rows[0].count).toBe(1);

    const analysisJobs = await pool.query(
      `SELECT COUNT(*)::int AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`,
      [targetSources[0].id],
    );
    expect(analysisJobs.rows[0].count).toBe(0);
  });

  it("L: reuses the source's channel collection under the SAME (provider, external_id) identity in the destination project", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject();
    const channelExternalId = randomId("channel");
    const { collection } = await createSourceCollection(pool, {
      projectId: origin.id,
      provider: "DISCORD",
      externalId: channelExternalId,
      title: "#trading-videos",
      sourceUrl: "https://discord.com/channels/guild/chan",
    });
    const source = await makeDiscordSourceIn(origin.id, identity, { collectionId: collection.id });

    const { body } = await callHandler(origin.id, source.id, identity, [target.id]);
    expect(body.results[0].kind).toBe("added");

    const targetCollections = await listSourceCollectionsByProjectId(pool, target.id);
    expect(targetCollections).toHaveLength(1);
    expect(targetCollections[0].externalId).toBe(channelExternalId);
    expect(targetCollections[0].id).not.toBe(collection.id);

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources[0].collectionId).toBe(targetCollections[0].id);
  });

  it("M: analysis is never copied — the destination starts unanalyzed even when the origin already has an analysis, and each keeps an independent history", async () => {
    const identity = randomId("identity");
    const origin = await makeProject("TRADING_STRATEGIES");
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeDiscordSourceIn(origin.id, identity);

    const job = await createJob(pool, source.id, randomId("fingerprint"));
    await createProjectSourceAnalysis(pool, {
      projectSourceId: source.id,
      jobId: job.jobId,
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
    });
    // createJob leaves the underlying job row QUEUED — this fixture only
    // needs the ANALYSIS row to exist, so mark it terminal directly rather
    // than leaving a stray QUEUED project_source_analysis_jobs row that a
    // LATER, unrelated test's real runProjectSourceAnalysisLoop call could
    // claim and process (the same class of cross-test/cross-run pollution
    // documented in tests/helpers/testDb.ts's randomSnowflake doc comment).
    await pool.query(`UPDATE project_source_analysis_jobs SET status = 'NO_STRATEGY', completed_at = now() WHERE job_id = $1`, [job.jobId]);

    const { body } = await callHandler(origin.id, source.id, identity, [target.id]);
    expect(body.results[0].kind).toBe("added");

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    const targetAnalysis = await getLatestByProjectSource(pool, targetSources[0].id);
    expect(targetAnalysis).toBeNull();

    // The origin's own analysis is untouched.
    const originAnalysis = await getLatestByProjectSource(pool, source.id);
    expect(originAnalysis).not.toBeNull();
  });

  it("N (acceptance criterion): 1 durable asset, 1 media copy, 3 project_sources — deleting one destination membership leaves the asset and every other membership intact", async () => {
    const identity = randomId("identity");
    const discordKnowledge = await makeProject("GENERAL_KNOWLEDGE");
    const trading = await makeProject("TRADING_STRATEGIES");
    const options = await makeProject("TRADING_STRATEGIES");
    const captured = await makeDiscordSourceIn(discordKnowledge.id, identity);

    const { body } = await callHandler(discordKnowledge.id, captured.id, identity, [trading.id, options.id]);
    expect(body.results.map((r) => r.kind)).toEqual(["added", "added"]);

    const tradingSources = await listProjectSourcesByProjectId(pool, trading.id);
    const optionsSources = await listProjectSourcesByProjectId(pool, options.id);
    expect(tradingSources).toHaveLength(1);
    expect(optionsSources).toHaveLength(1);
    expect(tradingSources[0].contentAssetId).toBe(captured.contentAssetId);
    expect(optionsSources[0].contentAssetId).toBe(captured.contentAssetId);

    // Exactly one physical media copy shared by all three — never duplicated per project.
    const mediaCount = await pool.query(`SELECT COUNT(*)::int AS count FROM content_asset_media WHERE content_asset_id = $1`, [captured.contentAssetId]);
    expect(mediaCount.rows[0].count).toBe(1);

    // Deleting the Trading membership must never cascade to the shared
    // asset or to any other project's membership — content_assets'
    // ON DELETE RESTRICT only ever blocks deleting the ASSET while any
    // project_source still references it; deleting one project_source
    // (a child row) is always safe regardless of how many siblings share
    // the same asset.
    await deleteProjectSource(pool, tradingSources[0].id);

    expect(await getProjectSourceById(pool, tradingSources[0].id)).toBeNull();
    expect(await getContentAssetById(pool, captured.contentAssetId!)).not.toBeNull();
    expect(await getContentAssetMedia(pool, captured.contentAssetId!)).not.toBeNull();
    expect(await getProjectSourceById(pool, captured.id)).not.toBeNull(); // Discord Knowledge
    expect(await getProjectSourceById(pool, optionsSources[0].id)).not.toBeNull(); // Options
  });
});
