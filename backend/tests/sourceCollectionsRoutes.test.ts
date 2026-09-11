import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import {
  createListSourceCollectionsHandler,
  createGetSourceCollectionHandler,
  createAddYouTubeCollectionHandler,
  createRefreshSourceCollectionHandler,
  createDeleteSourceCollectionHandler,
  type SourceCollectionsRouteDeps,
} from "../src/http/routes/sourceCollections.js";
import { createYouTubeSource, getProjectSourceById } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection, getSourceCollectionById } from "../src/db/sourceCollectionsRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const API_KEY = "test-yt-api-key";

function deps(overrides: Partial<SourceCollectionsRouteDeps> = {}): SourceCollectionsRouteDeps {
  return { pool, youtubeApiKey: API_KEY, ...overrides };
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
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

function callList(projectId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createListSourceCollectionsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGet(projectId: string, collectionId: string, query: Record<string, string> = {}, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createGetSourceCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId }, query } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAddYouTubeChannel(projectId: string, channelRef: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createAddYouTubeCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { channelRef } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRefresh(projectId: string, collectionId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createRefreshSourceCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callDelete(projectId: string, collectionId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createDeleteSourceCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> | undefined }));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function uploadsPlaylistIdFor(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

/**
 * Simulates the YouTube Data API for a single channel: `channels.list`
 * (by id and/or forHandle) and paginated `playlistItems.list`, newest
 * video first — mirroring real API ordering. `pageSize` lets a test force
 * multiple provider pages from a small fixture (real page size is 50, see
 * discoverYoutubeChannelVideos.ts's YOUTUBE_PLAYLIST_ITEMS_PAGE_SIZE) —
 * the constant itself is not overridden, only how many of the fixture's
 * videoIds this stub hands back per simulated page, so pagination/cursor
 * logic can be exercised deterministically without a 1,000+-item fixture.
 */
function stubYouTubeDataApi(opts: { channelId: string; channelTitle: string; videoIds: string[]; pageSize?: number; handle?: string }) {
  const pageSize = opts.pageSize ?? 50;
  const uploadsPlaylistId = uploadsPlaylistIdFor(opts.channelId);
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/youtube/v3/channels") {
      const forHandle = parsed.searchParams.get("forHandle");
      if (forHandle) {
        return forHandle === `@${opts.handle}` ? jsonResponse(200, { items: [{ id: opts.channelId }] }) : jsonResponse(200, { items: [] });
      }
      const id = parsed.searchParams.get("id");
      if (id === opts.channelId) {
        return jsonResponse(200, { items: [{ snippet: { title: opts.channelTitle }, contentDetails: { relatedPlaylists: { uploads: uploadsPlaylistId } } }] });
      }
      return jsonResponse(200, { items: [] });
    }
    if (parsed.pathname === "/youtube/v3/playlistItems") {
      if (parsed.searchParams.get("playlistId") !== uploadsPlaylistId) return jsonResponse(200, { items: [] });
      const pageToken = parsed.searchParams.get("pageToken");
      const startIndex = pageToken ? Number(pageToken) : 0;
      const pageIds = opts.videoIds.slice(startIndex, startIndex + pageSize);
      const nextIndex = startIndex + pageSize;
      const hasMore = nextIndex < opts.videoIds.length;
      return jsonResponse(200, {
        items: pageIds.map((id) => ({ snippet: { title: `Video ${id}`, publishedAt: "2026-01-01T00:00:00Z", resourceId: { videoId: id } } })),
        ...(hasMore ? { nextPageToken: String(nextIndex) } : {}),
      });
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(9, "0")}`);
}

describe("Source Collections routes — YouTube (Phase 4K)", () => {
  it("adds a YouTube channel by ID, discovers videos, never analyzes them", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["aaaaaaaaaaa", "bbbbbbbbbbb"] });

    const { statusCode, body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(statusCode).toBe(201);
    expect(body.discoveredCount).toBe(2);
    expect(body.importedCount).toBe(2);
    const collection = body.collection as Record<string, unknown>;
    expect(collection.title).toBe("SMB Capital");
    expect(collection.itemCount).toBe(2);
    expect(collection.analyzedCount).toBe(0);

    const jobCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj
       JOIN project_sources ps ON ps.id = psaj.project_source_id
       WHERE ps.project_id = $1`,
      [project.id],
    );
    expect(Number(jobCount.rows[0].count)).toBe(0);
  });

  it("responds 501 (not a generic failure) when YOUTUBE_API_KEY isn't configured, without ever calling fetch", async () => {
    const project = await makeProject();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { statusCode, body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw", deps({ youtubeApiKey: undefined }));
    expect(statusCode).toBe(501);
    expect((body.error as Record<string, unknown>).type).toBe("youtube_api_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adding the same channel twice is idempotent at the collection level, adopting already-discovered videos rather than duplicating them", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["ccccccccccc"] });
    const first = await callAddYouTubeChannel(String(project.id), "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const second = await callAddYouTubeChannel(String(project.id), "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw");

    expect((first.body.collection as Record<string, unknown>).id).toBe((second.body.collection as Record<string, unknown>).id);
    expect(second.body.adoptedCount).toBe(1);
    expect(second.body.importedCount).toBe(0);

    const { body: listBody } = await callList(String(project.id));
    expect((listBody.collections as unknown[]).length).toBe(1);
  });

  it("lists collections with lightweight item/analyzed counts, never full analysis payloads", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["ddddddddddd", "eeeeeeeeeee"] });
    await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");

    const { body: listBody } = await callList(String(project.id));
    const collections = listBody.collections as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(1);
    expect(collections[0]).not.toHaveProperty("validated_json");
    expect(collections[0].itemCount).toBe(2);
  });

  it("get collection detail returns items with status only, paginated", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["fffffffffff", "ggggggggggg"] });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;

    const sourcesResult = await pool.query<{ id: string }>(`SELECT id FROM project_sources WHERE collection_id = $1 ORDER BY created_at ASC LIMIT 1`, [collectionId]);
    await markAnalyzed(Number(sourcesResult.rows[0].id));

    const { statusCode, body } = await callGet(String(project.id), String(collectionId));
    expect(statusCode).toBe(200);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.status === "ANALYZED")).toBeTruthy();
    expect(items.find((i) => i.status === "NOT_ANALYZED")).toBeTruthy();
    expect((body.pagination as Record<string, unknown>).totalCount).toBe(2);
  });

  it("refresh re-discovers, preserving existing items/analyses and importing only new ones", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["hhhhhhhhhhh"] });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;
    const firstSource = await pool.query<{ id: string }>(`SELECT id FROM project_sources WHERE collection_id = $1`, [collectionId]);
    await markAnalyzed(Number(firstSource.rows[0].id));

    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["iiiiiiiiiii", "hhhhhhhhhhh"] });
    const { statusCode, body } = await callRefresh(String(project.id), String(collectionId));
    expect(statusCode).toBe(200);
    expect(body.importedCount).toBe(1);
    expect(body.adoptedCount).toBe(1);

    const analysisStillExists = await pool.query(`SELECT 1 FROM project_source_analyses WHERE project_source_id = $1`, [firstSource.rows[0].id]);
    expect(analysisStillExists.rows).toHaveLength(1);

    const { body: detail } = await callGet(String(project.id), String(collectionId));
    expect((detail.items as unknown[]).length).toBe(2);
  });

  it("refresh idempotency: refreshing twice with no provider changes creates zero duplicates", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["jjjjjjjjjjj"] });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;

    await callRefresh(String(project.id), String(collectionId));
    await callRefresh(String(project.id), String(collectionId));

    const { body: listBody } = await callList(String(project.id));
    expect((listBody.collections as Array<Record<string, unknown>>)[0].itemCount).toBe(1);
    const collectionCount = await pool.query(`SELECT COUNT(*) AS count FROM source_collections WHERE project_id = $1`, [project.id]);
    expect(Number((collectionCount.rows[0] as { count: string }).count)).toBe(1);
  });

  it("deleting a collection removes it but preserves member sources and their analyses", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["kkkkkkkkkkk"] });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;
    const sourceResult = await pool.query<{ id: string }>(`SELECT id FROM project_sources WHERE collection_id = $1`, [collectionId]);
    const sourceId = Number(sourceResult.rows[0].id);
    await markAnalyzed(sourceId);

    const { statusCode } = await callDelete(String(project.id), String(collectionId));
    expect(statusCode).toBe(204);

    const stillThere = await getProjectSourceById(pool, sourceId);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.collectionId).toBeNull();
    const analysisStillThere = await pool.query(`SELECT 1 FROM project_source_analyses WHERE project_source_id = $1`, [sourceId]);
    expect(analysisStillThere.rows).toHaveLength(1);
  });

  it("cross-project isolation: a collection from another project returns 404", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["lllllllllll"] });
    const { body: added } = await callAddYouTubeChannel(String(projectA.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;

    const { statusCode } = await callGet(String(projectB.id), String(collectionId));
    expect(statusCode).toBe(404);
  });

  it("an @handle channel reference is resolved via channels.list?forHandle= before discovery", async () => {
    const project = await makeProject();
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["mmmmmmmmmmm"], handle: "SMBCapital" });

    const { statusCode, body } = await callAddYouTubeChannel(String(project.id), "@SMBCapital");
    expect(statusCode).toBe(201);
    expect((body.collection as Record<string, unknown>).externalId).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("an invalid channel reference is rejected with 400, never reaching the network", async () => {
    const project = await makeProject();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { statusCode } = await callAddYouTubeChannel(String(project.id), "https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("existing à-la-carte YouTube source is ADOPTED (not duplicated) when its channel is later added", async () => {
    const project = await makeProject();
    const { source: alaCarte } = await createYouTubeSource(pool, { projectId: project.id, externalId: "nnnnnnnnnnn", sourceUrl: "https://www.youtube.com/watch?v=nnnnnnnnnnn" });
    await markAnalyzed(alaCarte.id);

    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital", videoIds: ["nnnnnnnnnnn"] });
    const { body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(body.adoptedCount).toBe(1);
    expect(body.importedCount).toBe(0);

    const adopted = await getProjectSourceById(pool, alaCarte.id);
    expect(adopted?.collectionId).toBe((body.collection as Record<string, unknown>).id);
    const analysisStillThere = await pool.query(`SELECT 1 FROM project_source_analyses WHERE project_source_id = $1`, [alaCarte.id]);
    expect(analysisStillThere.rows).toHaveLength(1);
  });
});

describe("Source Collections routes — YouTube full-channel catalog & pagination (Phase 4K follow-up)", () => {
  it("discovers well beyond the old RSS feed's ~15-item window in a single Add Channel call", async () => {
    const project = await makeProject();
    const videoIds = ids("v", 60);
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "Big Channel", videoIds, pageSize: 5 });

    const { statusCode, body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(statusCode).toBe(201);
    expect(body.discoveredCount).toBe(60);
    expect(body.importedCount).toBe(60);
    expect(body.hasMoreHistory).toBe(false);

    const { body: detail } = await callGet(String(project.id), String((body.collection as Record<string, unknown>).id), { limit: "200" });
    expect((detail.pagination as Record<string, unknown>).totalCount).toBe(60);
    // The 55th-60th (oldest) videos are well past position 15 — prove they're actually reachable, not just counted.
    const externalIds = (detail.items as Array<Record<string, unknown>>).map((i) => i.externalId);
    expect(externalIds).toContain(videoIds[59]);
  });

  it("a channel deeper than the per-call page cap leaves hasMoreHistory=true and a discoveryCursor, reaching the rest via a subsequent Refresh", async () => {
    const project = await makeProject();
    const videoIds = ids("d", 30); // 3 provider pages of 10 with pageSize:10
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "Deep Channel", videoIds, pageSize: 10 });

    // Cap the first pass at ONE page (10 videos) to simulate "channel bigger than one discovery pass can cover".
    const { statusCode, body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw", deps({ youtubeDiscoveryMaxPagesPerCall: 1 }));
    expect(statusCode).toBe(201);
    expect(body.importedCount).toBe(10);
    expect(body.hasMoreHistory).toBe(true);

    const collectionId = (body.collection as Record<string, unknown>).id as number;
    const afterFirstPass = await getSourceCollectionById(pool, collectionId);
    expect(afterFirstPass?.discoveryCursor).not.toBeNull();

    // Refresh (still capped at 1 page) continues from the cursor — reaching videos 11-20, not re-discovering 1-10 and not restarting from the newest video.
    const refreshOne = await callRefresh(String(project.id), String(collectionId), deps({ youtubeDiscoveryMaxPagesPerCall: 1 }));
    expect(refreshOne.body.importedCount).toBe(10);
    expect(refreshOne.body.adoptedCount).toBe(0);
    expect(refreshOne.body.hasMoreHistory).toBe(true);

    // One more refresh reaches the final 10 (videos 21-30) and finally catches up.
    const refreshTwo = await callRefresh(String(project.id), String(collectionId), deps({ youtubeDiscoveryMaxPagesPerCall: 1 }));
    expect(refreshTwo.body.importedCount).toBe(10);
    expect(refreshTwo.body.hasMoreHistory).toBe(false);

    const { body: detail } = await callGet(String(project.id), String(collectionId), { limit: "200" });
    expect((detail.pagination as Record<string, unknown>).totalCount).toBe(30);
    const externalIds = (detail.items as Array<Record<string, unknown>>).map((i) => i.externalId);
    // The OLDEST video (last in upload order) is reachable only after both continuation refreshes.
    expect(externalIds).toContain(videoIds[29]);

    const afterCaughtUp = await getSourceCollectionById(pool, collectionId);
    expect(afterCaughtUp?.discoveryCursor).toBeNull();
  });

  it("once fully caught up, a duplicate refresh (no provider changes) creates zero duplicate rows and stops at the first fully-known page", async () => {
    const project = await makeProject();
    const videoIds = ids("e", 20);
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "Chan", videoIds, pageSize: 5 });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;
    expect(added.hasMoreHistory).toBe(false);

    const refreshMock = stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "Chan", videoIds, pageSize: 5 });
    const { body } = await callRefresh(String(project.id), String(collectionId));
    expect(body.importedCount).toBe(0);
    expect(body.adoptedCount).toBe(5); // early-stop after confirming the FIRST page (5 videos) is fully known, never walks all 20 again
    // Only one playlistItems page was fetched (plus one channels.list call) — confirms the early-stop, not a full re-walk.
    const playlistCalls = refreshMock.mock.calls.filter(([url]) => (url as string).includes("/playlistItems")).length;
    expect(playlistCalls).toBe(1);

    const countResult = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(Number((countResult.rows[0] as { count: string }).count)).toBe(20);
  });

  it("newly-discovered videos are never auto-analyzed, and a video analyzed before a deep-history refresh keeps its analysis", async () => {
    const project = await makeProject();
    const videoIds = ids("f", 10);
    stubYouTubeDataApi({ channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "Chan", videoIds, pageSize: 5 });
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw", deps({ youtubeDiscoveryMaxPagesPerCall: 1 }));
    const collectionId = (added.collection as Record<string, unknown>).id as number;
    expect(added.hasMoreHistory).toBe(true);

    const firstBatch = await pool.query<{ id: string }>(`SELECT id FROM project_sources WHERE collection_id = $1`, [collectionId]);
    await markAnalyzed(Number(firstBatch.rows[0].id));

    const { body } = await callRefresh(String(project.id), String(collectionId), deps({ youtubeDiscoveryMaxPagesPerCall: 1 }));
    expect(body.hasMoreHistory).toBe(false);
    expect(body.importedCount).toBe(5);

    const jobCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj JOIN project_sources ps ON ps.id = psaj.project_source_id WHERE ps.collection_id = $1`,
      [collectionId],
    );
    expect(Number(jobCount.rows[0].count)).toBe(1); // only the one we explicitly marked — refresh never triggers analysis

    const analysisStillThere = await pool.query(`SELECT 1 FROM project_source_analyses WHERE project_source_id = $1`, [firstBatch.rows[0].id]);
    expect(analysisStillThere.rows).toHaveLength(1);
  });
});

describe("Source Collections — project isolation at the DB layer (Phase 4K)", () => {
  it("provider identity uniqueness allows the SAME channel in two different projects independently", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await createSourceCollection(pool, { projectId: projectA.id, provider: "YOUTUBE", externalId: "UCshared0000000000000000", title: "Shared", sourceUrl: "https://x" });
    const { created } = await createSourceCollection(pool, { projectId: projectB.id, provider: "YOUTUBE", externalId: "UCshared0000000000000000", title: "Shared", sourceUrl: "https://x" });
    expect(created).toBe(true);
  });
});
