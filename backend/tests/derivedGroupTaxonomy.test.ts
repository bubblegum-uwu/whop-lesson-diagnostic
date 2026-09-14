import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  classifyDerivedGroups,
  listDerivedGroupsForProject,
  listDerivedGroupMemberSourceIds,
} from "../src/db/derivedSourceGroupsRepo.js";
import {
  createListSourceCollectionsHandler,
  createGetSourceCollectionHandler,
  type SourceCollectionsRouteDeps,
} from "../src/http/routes/sourceCollections.js";
import { createAnalyzeCollectionHandler, type ProjectSourceAnalysisRouteDeps } from "../src/http/routes/projectSourceAnalysis.js";
import {
  createCreateSynthesisSetHandler,
  createGetSynthesisSetHandler,
  createBulkAddCollectionToSynthesisSetHandler,
  createBulkRemoveCollectionFromSynthesisSetHandler,
  type SynthesisSetsRouteDeps,
} from "../src/http/routes/synthesisSets.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { insertManualOrigin, insertDiscordChannelOrigin } from "../src/db/projectSourceOriginsRepo.js";
import { listAlaCarteWhopLessonsByProjectId, createWhopLessonImport } from "../src/db/whopLessonImportsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";
import type { JobTrigger } from "../src/jobs/runJobTrigger.js";
import { vi } from "vitest";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

const YOUTUBE_API_KEY = "test-yt-api-key";
const GEMINI_MODEL = "gemini-3.8-flash";

function collectionsDeps(): SourceCollectionsRouteDeps {
  return { pool, youtubeApiKey: YOUTUBE_API_KEY };
}
function makeJobTrigger(): JobTrigger {
  return { triggerRun: vi.fn(async () => undefined) };
}
function analysisDeps(jobTrigger: JobTrigger = makeJobTrigger()): ProjectSourceAnalysisRouteDeps {
  return { pool, jobTrigger, geminiModel: GEMINI_MODEL };
}
function synthesisSetsDeps(): SynthesisSetsRouteDeps {
  return { pool };
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

function newVideoExternalId(): string {
  return randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0");
}

async function makeYouTubeSourceViaDiscordChannel(
  projectId: number,
  opts: { guildId: string; channelId: string; channelName?: string | null },
) {
  const { source } = await createYouTubeSource(pool, {
    projectId,
    externalId: newVideoExternalId(),
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  await insertDiscordChannelOrigin(pool, {
    projectSourceId: source.id,
    guildId: opts.guildId,
    channelId: opts.channelId,
    channelName: opts.channelName ?? null,
    messageId: randomId("msg"),
    messageUrl: null,
    postedAt: new Date(),
  });
  return source;
}

async function makeManualYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: newVideoExternalId(), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await insertManualOrigin(pool, source.id);
  return source;
}

/** The raw-Discord-CDN-URL-paste add path — createAddDiscordSourceHandler never inserts any origin at all. */
async function makeChannelLessDiscordSource(projectId: number) {
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
  const { createProjectSourceAnalysis } = await import("../src/db/projectSourceAnalysesRepo.js");
  const { EMPTY_LESSON_KNOWLEDGE } = await import("../src/gemini/schema.js");
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

function callListCollections(projectId: string) {
  const handler = createListSourceCollectionsHandler(collectionsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGetCollection(projectId: string, groupKey: string) {
  const handler = createGetSourceCollectionHandler(collectionsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId: groupKey }, query: {} } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAnalyzeCollection(projectId: string, groupKey: string, jobTrigger?: JobTrigger) {
  const handler = createAnalyzeCollectionHandler(analysisDeps(jobTrigger));
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId: groupKey } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callCreateSet(projectId: string, name: string) {
  const handler = createCreateSynthesisSetHandler(synthesisSetsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { name } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGetSet(projectId: string, setId: string) {
  const handler = createGetSynthesisSetHandler(synthesisSetsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkAddCollectionToSet(projectId: string, setId: string, groupKey: string) {
  const handler = createBulkAddCollectionToSynthesisSetHandler(synthesisSetsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId, collectionId: groupKey } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callBulkRemoveCollectionFromSet(projectId: string, setId: string, groupKey: string) {
  const handler = createBulkRemoveCollectionFromSynthesisSetHandler(synthesisSetsDeps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, setId, collectionId: groupKey } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

describe("Phase 4L taxonomy correction — derived group classification (13 scenarios)", () => {
  it("1: a YouTube video with Discord-channel provenance classifies into the youtube-discord-channel derived group", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1", channelName: "scarface-alerts" });
    const rows = await classifyDerivedGroups(pool, project.id);
    const row = rows.find((r) => r.sourceId === source.id);
    expect(row?.groupKey).toBe("derived:youtube-discord-channel:g1:c1");
    expect(row?.sourceType).toBe("CHANNEL");
    expect(row?.originProvider).toBe("DISCORD");
  });

  it("2: two YouTube sources posted to the SAME Discord channel land in the SAME group", async () => {
    const project = await makeProject();
    const a = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const b = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const groups = await listDerivedGroupsForProject(pool, project.id);
    const group = groups.find((g) => g.groupKey === "derived:youtube-discord-channel:g1:c1")!;
    expect(group.memberSourceIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("3: sources posted to two DIFFERENT Discord channels land in two SEPARATE groups", async () => {
    const project = await makeProject();
    const a = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const b = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c2" });
    const groups = await listDerivedGroupsForProject(pool, project.id);
    const groupA = groups.find((g) => g.groupKey === "derived:youtube-discord-channel:g1:c1")!;
    const groupB = groups.find((g) => g.groupKey === "derived:youtube-discord-channel:g1:c2")!;
    expect(groupA.memberSourceIds).toEqual([a.id]);
    expect(groupB.memberSourceIds).toEqual([b.id]);
  });

  it("4: a Discord right-click capture (real persisted source_collections row) renders as DISCORD/CHANNEL, never a derived group", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "DISCORD", externalId: "g1:c1", title: "#pre-market-live", sourceUrl: "https://discord.com/channels/g1/c1" });
    const { body } = await callListCollections(String(project.id));
    const summary = (body.collections as Array<Record<string, unknown>>).find((c) => c.groupKey === String(collection.id));
    expect(summary).toBeDefined();
    expect(summary?.kind).toBe("PERSISTED");
    expect(summary?.provider).toBe("DISCORD");
    expect(summary?.sourceType).toBe("CHANNEL");
  });

  it("5: a Discord right-click capture is NEVER classified as Discord à-la-carte", async () => {
    const project = await makeProject();
    await createSourceCollection(pool, { projectId: project.id, provider: "DISCORD", externalId: "g2:c2", title: "#trade-ideas", sourceUrl: "https://discord.com/channels/g2/c2" });
    const { body } = await callListCollections(String(project.id));
    const collections = body.collections as Array<Record<string, unknown>>;
    expect(collections.some((c) => c.sourceType === "A_LA_CARTE" && c.provider === "DISCORD")).toBe(false);
  });

  it("6: a genuinely manual YouTube add classifies into YOUTUBE/A_LA_CARTE", async () => {
    const project = await makeProject();
    const source = await makeManualYouTubeSource(project.id);
    const rows = await classifyDerivedGroups(pool, project.id);
    const row = rows.find((r) => r.sourceId === source.id);
    expect(row?.groupKey).toBe("derived:youtube-ala-carte");
    expect(row?.sourceType).toBe("A_LA_CARTE");
    expect(row?.originProvider).toBe("MANUAL");
  });

  it("7: a Discord-discovered YouTube video is NEVER classified as YOUTUBE/A_LA_CARTE, even without a manual origin", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const rows = await classifyDerivedGroups(pool, project.id);
    const row = rows.find((r) => r.sourceId === source.id);
    expect(row?.groupKey).not.toBe("derived:youtube-ala-carte");
  });

  it("8: a real, persisted YouTube channel collection still summarizes as PERSISTED/CHANNEL (unaffected regression)", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCabc", title: "TraderTV", sourceUrl: "https://www.youtube.com/channel/UCabc" });
    const { body } = await callListCollections(String(project.id));
    const summary = (body.collections as Array<Record<string, unknown>>).find((c) => c.groupKey === String(collection.id));
    expect(summary?.kind).toBe("PERSISTED");
    expect(summary?.provider).toBe("YOUTUBE");
    expect(summary?.sourceType).toBe("CHANNEL");
  });

  it("9: a Whop course lives entirely outside project_sources — never appears in derived-group classification at all", async () => {
    const project = await makeProject();
    const courseResult = await pool.query<{ id: string }>(
      `INSERT INTO courses (whop_course_id, whop_experience_id, slug, title, project_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [randomId("course"), randomId("exp"), randomId("slug"), "Scarface Mastermind", project.id],
    );
    await pool.query(
      `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', $4)`,
      [courseResult.rows[0].id, randomId("lesson"), "Lesson 1", "https://whop.com/lessons/1"],
    );
    const rows = await classifyDerivedGroups(pool, project.id);
    expect(rows).toEqual([]);
  });

  it("10: a real à-la-carte Whop lesson import is returned by the existing acquisition flow, without fabricating data", async () => {
    const project = await makeProject();
    const courseResult = await pool.query<{ id: string }>(
      `INSERT INTO courses (whop_course_id, whop_experience_id, slug, title) VALUES ($1, $2, $3, $4) RETURNING id`,
      [randomId("course"), randomId("exp"), randomId("slug"), "Scarface Mastermind"],
    );
    const lessonResult = await pool.query<{ id: string }>(
      `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', $4) RETURNING id`,
      [courseResult.rows[0].id, randomId("lesson"), "Risk Management 101", "https://whop.com/lessons/2"],
    );
    await createWhopLessonImport(pool, project.id, Number(lessonResult.rows[0].id));
    const lessons = await listAlaCarteWhopLessonsByProjectId(pool, project.id);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].title).toBe("Risk Management 101");
  });

  it("11: a genuinely unclassifiable source (raw Discord CDN paste, no origin) classifies as Unclassified, never Discord à-la-carte", async () => {
    const project = await makeProject();
    const source = await makeChannelLessDiscordSource(project.id);
    const rows = await classifyDerivedGroups(pool, project.id);
    const row = rows.find((r) => r.sourceId === source.id);
    expect(row?.groupKey).toBe("derived:unclassified");
    expect(row?.sourceType).toBe("UNCLASSIFIED");
  });

  it("12: a multi-origin source (Manual + Discord-channel) resolves to exactly ONE primary group — Discord-channel wins, never duplicated into youtube-ala-carte too", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await insertManualOrigin(pool, source.id);
    const groups = await listDerivedGroupsForProject(pool, project.id);
    const groupsContainingSource = groups.filter((g) => g.memberSourceIds.includes(source.id));
    expect(groupsContainingSource).toHaveLength(1);
    expect(groupsContainingSource[0].groupKey).toBe("derived:youtube-discord-channel:g1:c1");
  });

  it("13: stable group identity uses the Discord channel ID, not its display name — a later channel rename never changes the groupKey", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1", channelName: "old-name" });
    const before = await listDerivedGroupMemberSourceIds(pool, project.id, "derived:youtube-discord-channel:g1:c1");
    expect(before).toEqual([source.id]);

    // A later scan enriches the channel name — the origin row is updated, but its channel_id (identity) never changes.
    await insertDiscordChannelOrigin(pool, { projectSourceId: source.id, guildId: "g1", channelId: "c1", channelName: "new-name", messageId: randomId("msg2"), messageUrl: null, postedAt: new Date() });
    const after = await listDerivedGroupMemberSourceIds(pool, project.id, "derived:youtube-discord-channel:g1:c1");
    expect(after).toEqual([source.id]);
  });
});

describe("Phase 4L taxonomy correction — collection/group operations (8 scenarios)", () => {
  it("14: opening a derived Discord-origin YouTube group returns exactly its members, never more, never fewer", async () => {
    const project = await makeProject();
    const inGroup = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const outsideGroup = await makeManualYouTubeSource(project.id);
    const { statusCode, body } = await callGetCollection(String(project.id), "derived:youtube-discord-channel:g1:c1");
    expect(statusCode).toBe(200);
    const items = body.items as Array<{ id: number }>;
    expect(items.map((i) => i.id)).toEqual([inGroup.id]);
    expect(items.map((i) => i.id)).not.toContain(outsideGroup.id);
  });

  it("15: analyzing a derived group resolves EXACTLY its members server-side, never a caller-supplied or wrong list", async () => {
    const project = await makeProject();
    const inGroup = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const outsideGroup = await makeManualYouTubeSource(project.id);
    const jobTrigger = makeJobTrigger();
    const { statusCode, body } = await callAnalyzeCollection(String(project.id), "derived:youtube-discord-channel:g1:c1", jobTrigger);
    expect(statusCode).toBe(200);
    expect(body.queued).toBe(1);
    expect(jobTrigger.triggerRun).toHaveBeenCalledTimes(1);

    const { getLatestJobForProjectSource } = await import("../src/db/projectSourceAnalysisJobsRepo.js");
    expect(await getLatestJobForProjectSource(pool, inGroup.id)).not.toBeNull();
    expect(await getLatestJobForProjectSource(pool, outsideGroup.id)).toBeNull();
  });

  it("16: analyzing a derived group creates NO Synthesis Set memberships — analysis and selection stay fully separate", async () => {
    const project = await makeProject();
    const source = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await callAnalyzeCollection(String(project.id), "derived:youtube-discord-channel:g1:c1");
    const membershipCount = await pool.query(`SELECT 1 FROM synthesis_set_sources WHERE project_source_id = $1`, [source.id]);
    expect(membershipCount.rows).toEqual([]);
  });

  it("17: selecting a derived group into a Synthesis Set adds only its CURRENTLY-eligible members", async () => {
    const project = await makeProject();
    const eligible = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(eligible.id);
    const notYetAnalyzed = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    void notYetAnalyzed;

    const { body: created } = await callCreateSet(String(project.id), "Discord Alerts Set");
    const { statusCode, body } = await callBulkAddCollectionToSet(String(project.id), String(created.id), "derived:youtube-discord-channel:g1:c1");
    expect(statusCode).toBe(200);
    expect(body).toEqual({ collectionId: "derived:youtube-discord-channel:g1:c1", eligibleCount: 1, alreadySelectedCount: 0, addedCount: 1, ineligibleCount: 1 });

    const { body: detail } = await callGetSet(String(project.id), String(created.id));
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id);
    expect(memberIds).toEqual([eligible.id]);
  });

  it("18: selecting the same derived group twice is idempotent — the second call reports already-selected, adds nothing new", async () => {
    const project = await makeProject();
    const eligible = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(eligible.id);
    const { body: created } = await callCreateSet(String(project.id), "s");

    await callBulkAddCollectionToSet(String(project.id), String(created.id), "derived:youtube-discord-channel:g1:c1");
    const { body: second } = await callBulkAddCollectionToSet(String(project.id), String(created.id), "derived:youtube-discord-channel:g1:c1");
    expect(second).toEqual({ collectionId: "derived:youtube-discord-channel:g1:c1", eligibleCount: 1, alreadySelectedCount: 1, addedCount: 0, ineligibleCount: 0 });
  });

  it("19: SNAPSHOT invariant — a new source later posted to the SAME Discord channel never auto-joins an already-selected set", async () => {
    const project = await makeProject();
    const eligible = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(eligible.id);
    const { body: created } = await callCreateSet(String(project.id), "s");
    await callBulkAddCollectionToSet(String(project.id), String(created.id), "derived:youtube-discord-channel:g1:c1");

    const lateArrival = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(lateArrival.id);

    const { body: detail } = await callGetSet(String(project.id), String(created.id));
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id);
    expect(memberIds).not.toContain(lateArrival.id);
    expect(memberIds).toEqual([eligible.id]);
  });

  it("20: SNAPSHOT invariant — a member that becomes analyzed AFTER the snapshot is never auto-added either", async () => {
    const project = await makeProject();
    const eligible = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(eligible.id);
    const notYetAnalyzed = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    const { body: created } = await callCreateSet(String(project.id), "s");
    await callBulkAddCollectionToSet(String(project.id), String(created.id), "derived:youtube-discord-channel:g1:c1");

    await markAnalyzed(notYetAnalyzed.id); // eligible only AFTER the snapshot

    const { body: detail } = await callGetSet(String(project.id), String(created.id));
    const memberIds = (detail.sources as Array<{ id: number }>).map((s) => s.id);
    expect(memberIds).not.toContain(notYetAnalyzed.id);
  });

  it("21: removing a derived group from ONE Synthesis Set never affects another set that also selected it", async () => {
    const project = await makeProject();
    const eligible = await makeYouTubeSourceViaDiscordChannel(project.id, { guildId: "g1", channelId: "c1" });
    await markAnalyzed(eligible.id);
    const { body: setA } = await callCreateSet(String(project.id), "Set A");
    const { body: setB } = await callCreateSet(String(project.id), "Set B");
    await callBulkAddCollectionToSet(String(project.id), String(setA.id), "derived:youtube-discord-channel:g1:c1");
    await callBulkAddCollectionToSet(String(project.id), String(setB.id), "derived:youtube-discord-channel:g1:c1");

    const { statusCode, body } = await callBulkRemoveCollectionFromSet(String(project.id), String(setA.id), "derived:youtube-discord-channel:g1:c1");
    expect(statusCode).toBe(200);
    expect(body).toEqual({ collectionId: "derived:youtube-discord-channel:g1:c1", removedCount: 1 });

    const { body: detailA } = await callGetSet(String(project.id), String(setA.id));
    expect(detailA.sourceCount).toBe(0);
    const { body: detailB } = await callGetSet(String(project.id), String(setB.id));
    expect(detailB.sourceCount).toBe(1);
  });
});
