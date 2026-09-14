import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { createAddCollectionToProjectHandler, type AddCollectionToProjectResponse } from "../src/http/routes/sourceCollections.js";
import { createYouTubeSource, createDiscordSource, listProjectSourcesByProjectId } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection, listSourceCollectionsByProjectId } from "../src/db/sourceCollectionsRepo.js";
import { insertManualOrigin, insertDiscordChannelOrigin, listOriginsBySourceIds } from "../src/db/projectSourceOriginsRepo.js";
import { saveContentAssetMedia } from "../src/db/contentAssetsRepo.js";
import { createProjectSourceAnalysis, getLatestByProjectSource } from "../src/db/projectSourceAnalysesRepo.js";
import { listDerivedGroupsForProject } from "../src/db/derivedSourceGroupsRepo.js";
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

function newVideoExternalId(): string {
  return randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0");
}

async function makeYouTubeSourceViaDiscordChannel(projectId: number, guildId: string, channelId: string, channelName: string | null = null) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: newVideoExternalId(), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await insertDiscordChannelOrigin(pool, { projectSourceId: source.id, guildId, channelId, channelName, messageId: randomId("msg"), messageUrl: null, postedAt: new Date("2026-09-12T00:00:00Z") });
  return source;
}

async function makeManualYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: newVideoExternalId(), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await insertManualOrigin(pool, source.id);
  return source;
}

async function makeDiscordSourceIn(projectId: number, ownerIdentity: string, collectionId: number | null = null) {
  const externalId = randomSnowflake();
  const { source } = await createDiscordSource(pool, { projectId, ownerIdentity, externalId, sourceUrl: `https://cdn.discordapp.com/attachments/1/${externalId}/clip.mp4`, collectionId });
  await saveContentAssetMedia(pool, { contentAssetId: source.contentAssetId!, content: Buffer.from("fake-video-bytes"), contentType: "video/mp4", byteSize: 16 });
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

function callAddCollection(projectId: number, groupKey: string, targetProjectIds: unknown, knoveraOperator = "test-identity") {
  const handler = createAddCollectionToProjectHandler({ pool, youtubeApiKey: "test-key" });
  const { res, statusCode, body } = makeResponse();
  const req = { params: { projectId: String(projectId), collectionId: groupKey }, body: { targetProjectIds }, knoveraOperator } as unknown as Request;
  return handler(req, res).then(() => ({ statusCode: statusCode(), body: body() as AddCollectionToProjectResponse & { error?: { type: string } } }));
}

describe("POST /api/projects/:projectId/collections/:collectionId/add-to-project (Phase 4L follow-up)", () => {
  it("1: adds a persisted Discord channel collection's members to a destination project", async () => {
    const identity = randomId("identity");
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    const { collection } = await createSourceCollection(pool, { projectId: origin.id, provider: "DISCORD", externalId: "g1:c1", title: "#pre-market-live", sourceUrl: "https://discord.com/channels/g1/c1" });
    await makeDiscordSourceIn(origin.id, identity, collection.id);
    await makeDiscordSourceIn(origin.id, identity, collection.id);

    const { statusCode, body } = await callAddCollection(origin.id, String(collection.id), [target.id], identity);
    expect(statusCode).toBe(200);
    expect(body.memberCount).toBe(2);
    expect(body.results[0]).toMatchObject({ targetProjectId: target.id, kind: "ok", addedCount: 2, alreadyPresentCount: 0 });

    const targetCollections = await listSourceCollectionsByProjectId(pool, target.id);
    expect(targetCollections).toHaveLength(1);
    expect(targetCollections[0].provider).toBe("DISCORD");
    expect(targetCollections[0].externalId).toBe("g1:c1");
    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(2);
  });

  it("2: adds a derived YouTube-via-Discord-channel group's members to a destination project", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1", "scarface-alerts");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1", "scarface-alerts");

    const { statusCode, body } = await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);
    expect(statusCode).toBe(200);
    expect(body.results[0]).toMatchObject({ kind: "ok", addedCount: 2, alreadyPresentCount: 0 });

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(2);
    expect(targetSources.every((s) => s.collectionId === null)).toBe(true); // no fabricated persisted collection for a derived group
  });

  it("3: adds a manual YouTube à-la-carte group's members to a destination project", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeManualYouTubeSource(origin.id);

    const { statusCode, body } = await callAddCollection(origin.id, "derived:youtube-ala-carte", [target.id]);
    expect(statusCode).toBe(200);
    expect(body.results[0]).toMatchObject({ kind: "ok", addedCount: 1, alreadyPresentCount: 0 });
  });

  it("4: an existing destination source is not duplicated — reported already_present", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeManualYouTubeSource(origin.id);
    // The exact same video already exists à la carte in the target.
    await createYouTubeSource(pool, { projectId: target.id, externalId: source.externalId, sourceUrl: source.sourceUrl });

    const { body } = await callAddCollection(origin.id, "derived:youtube-ala-carte", [target.id]);
    expect(body.results[0]).toMatchObject({ addedCount: 0, alreadyPresentCount: 1 });
    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1); // never duplicated
  });

  it("5: repeated collection-add is idempotent — the second call reports already_present, adds nothing new", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);
    const { body: second } = await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);
    expect(second.results[0]).toMatchObject({ addedCount: 0, alreadyPresentCount: 1 });
    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1);
  });

  it("6: provenance (Discord guild/channel/message metadata, posted_at) is preserved in the destination", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1", "scarface-alerts");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const [targetSource] = await listProjectSourcesByProjectId(pool, target.id);
    const originsByTarget = await listOriginsBySourceIds(pool, [targetSource.id]);
    const origins = originsByTarget.get(targetSource.id) ?? [];
    expect(origins).toHaveLength(1);
    expect(origins[0].originType).toBe("DISCORD_CHANNEL");
    expect(origins[0].discordGuildId).toBe("g1");
    expect(origins[0].discordChannelId).toBe("c1");
    expect(origins[0].discordChannelName).toBe("scarface-alerts");
    expect(origins[0].discordPostedAt?.toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("7: destination grouping matches source grouping — the SAME canonical derived group resolves in the destination", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1", "scarface-alerts");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const targetGroups = await listDerivedGroupsForProject(pool, target.id);
    const group = targetGroups.find((g) => g.groupKey === "derived:youtube-discord-channel:g1:c1");
    expect(group).toBeDefined();
    expect(group?.title).toBe("Discord · #scarface-alerts");
    expect(group?.memberSourceIds).toHaveLength(1);
  });

  it("8: no analysis auto-starts in the destination — the copied source has no job", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const { getLatestJobForProjectSource } = await import("../src/db/projectSourceAnalysisJobsRepo.js");
    const [targetSource] = await listProjectSourcesByProjectId(pool, target.id);
    expect(await getLatestJobForProjectSource(pool, targetSource.id)).toBeNull();
  });

  it("9: analysis results from the source project are never copied to the destination", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");
    await markAnalyzed(source.id);

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const [targetSource] = await listProjectSourcesByProjectId(pool, target.id);
    expect(await getLatestByProjectSource(pool, targetSource.id)).toBeNull();
  });

  it("10: no Synthesis Set membership is created for the destination's copied sources", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const [targetSource] = await listProjectSourcesByProjectId(pool, target.id);
    const membership = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE project_source_id = $1`, [targetSource.id]);
    expect(membership.rows).toEqual([]);
  });

  it("11: SNAPSHOT invariant — a source added to the origin group AFTER the copy never auto-appears in the destination", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");
    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    // A new video posted to the SAME Discord channel, after the snapshot.
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");

    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(1); // still just the one copied at snapshot time
  });

  it("12: re-running Add Collection to Project adds exactly the newly-missing item", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");
    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1"); // late arrival in the origin group

    const { body: second } = await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);
    expect(second.results[0]).toMatchObject({ addedCount: 1, alreadyPresentCount: 1 });
    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(2);
  });

  it("13: the source project's own collection/group and members are completely unchanged", async () => {
    const origin = await makeProject();
    const target = await makeProject("TRADING_STRATEGIES");
    const source = await makeYouTubeSourceViaDiscordChannel(origin.id, "g1", "c1");

    await callAddCollection(origin.id, "derived:youtube-discord-channel:g1:c1", [target.id]);

    const originSourcesAfter = await listProjectSourcesByProjectId(pool, origin.id);
    expect(originSourcesAfter).toHaveLength(1);
    expect(originSourcesAfter[0].id).toBe(source.id);
    const originGroups = await listDerivedGroupsForProject(pool, origin.id);
    expect(originGroups.find((g) => g.groupKey === "derived:youtube-discord-channel:g1:c1")?.memberSourceIds).toEqual([source.id]);
  });

  it("rejects adding a collection to itself (same project) as invalid, without side effects", async () => {
    const project = await makeProject();
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c1");
    const { body } = await callAddCollection(project.id, "derived:youtube-discord-channel:g1:c1", [project.id]);
    expect(body.results[0].kind).toBe("invalid");
    const sources = await listProjectSourcesByProjectId(pool, project.id);
    expect(sources).toHaveLength(1);
  });

  it("a Discord source's request is unauthorized (and thus failed) when the requester isn't the asset owner", async () => {
    const owner = randomId("owner");
    const requester = randomId("someone-else");
    const origin = await makeProject();
    const target = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: origin.id, provider: "DISCORD", externalId: "g2:c2", title: "#trade-ideas", sourceUrl: "https://discord.com/channels/g2/c2" });
    await makeDiscordSourceIn(origin.id, owner, collection.id);

    const { body } = await callAddCollection(origin.id, String(collection.id), [target.id], requester);
    expect(body.results[0]).toMatchObject({ kind: "ok", addedCount: 0, alreadyPresentCount: 0, failedCount: 1 });
    const targetSources = await listProjectSourcesByProjectId(pool, target.id);
    expect(targetSources).toHaveLength(0);
  });

  it("returns 404 for an unknown/empty collection groupKey", async () => {
    const project = await makeProject();
    const target = await makeProject();
    const { statusCode } = await callAddCollection(project.id, "derived:youtube-discord-channel:none:none", [target.id]);
    expect(statusCode).toBe(404);
  });
});

