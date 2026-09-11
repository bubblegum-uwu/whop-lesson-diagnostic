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
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
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

function deps(): SourceCollectionsRouteDeps {
  return { pool };
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

function callList(projectId: string) {
  const handler = createListSourceCollectionsHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGet(projectId: string, collectionId: string, query: Record<string, string> = {}) {
  const handler = createGetSourceCollectionHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId }, query } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAddYouTubeChannel(projectId: string, channelRef: string) {
  const handler = createAddYouTubeCollectionHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { channelRef } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRefresh(projectId: string, collectionId: string) {
  const handler = createRefreshSourceCollectionHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callDelete(projectId: string, collectionId: string) {
  const handler = createDeleteSourceCollectionHandler(deps());
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> | undefined }));
}

const SAMPLE_FEED = (title: string, ids: string[]) => `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>${title}</title>
  ${ids.map((id) => `<entry><yt:videoId>${id}</yt:videoId><title>Video ${id}</title><published>2026-01-01T00:00:00+00:00</published></entry>`).join("\n")}
</feed>`;

function stubYouTubeFetch(channelId: string, title: string, videoIds: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/feeds/videos.xml")) {
        return new Response(SAMPLE_FEED(title, videoIds), { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

describe("Source Collections routes — YouTube (Phase 4K)", () => {
  it("adds a YouTube channel by ID, discovers videos, never analyzes them", async () => {
    const project = await makeProject();
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["aaaaaaaaaaa", "bbbbbbbbbbb"]);

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

  it("adding the same channel twice is idempotent at the collection level, adopting already-discovered videos rather than duplicating them", async () => {
    const project = await makeProject();
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["ccccccccccc"]);
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
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["ddddddddddd", "eeeeeeeeeee"]);
    await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");

    const { body: listBody } = await callList(String(project.id));
    const collections = listBody.collections as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(1);
    expect(collections[0]).not.toHaveProperty("validated_json");
    expect(collections[0].itemCount).toBe(2);
  });

  it("get collection detail returns items with status only, paginated", async () => {
    const project = await makeProject();
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["fffffffffff", "ggggggggggg"]);
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
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["hhhhhhhhhhh"]);
    const { body: added } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;
    const firstSource = await pool.query<{ id: string }>(`SELECT id FROM project_sources WHERE collection_id = $1`, [collectionId]);
    await markAnalyzed(Number(firstSource.rows[0].id));

    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["hhhhhhhhhhh", "iiiiiiiiiii"]);
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
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["jjjjjjjjjjj"]);
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
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["kkkkkkkkkkk"]);
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
    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["lllllllllll"]);
    const { body: added } = await callAddYouTubeChannel(String(projectA.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    const collectionId = (added.collection as Record<string, unknown>).id as number;

    const { statusCode } = await callGet(String(projectB.id), String(collectionId));
    expect(statusCode).toBe(404);
  });

  it("an @handle channel reference is resolved via the canonical link before discovery", async () => {
    const project = await makeProject();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://www.youtube.com/@SMBCapital") {
          return new Response(`<link rel="canonical" href="https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw">`, { status: 200 });
        }
        if (url.includes("/feeds/videos.xml")) {
          return new Response(SAMPLE_FEED("SMB Capital", ["mmmmmmmmmmm"]), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );

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

    stubYouTubeFetch("UC_x5XG1OV2P6uZZ5FSM9Ttw", "SMB Capital", ["nnnnnnnnnnn"]);
    const { body } = await callAddYouTubeChannel(String(project.id), "UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(body.adoptedCount).toBe(1);
    expect(body.importedCount).toBe(0);

    const adopted = await getProjectSourceById(pool, alaCarte.id);
    expect(adopted?.collectionId).toBe((body.collection as Record<string, unknown>).id);
    const analysisStillThere = await pool.query(`SELECT 1 FROM project_source_analyses WHERE project_source_id = $1`, [alaCarte.id]);
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
