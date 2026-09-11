import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import type { Request } from "express";
import { createImportDiscordChannelsHandler, type DiscordChannelsRouteDeps } from "../src/http/routes/discordChannels.js";
import {
  createGetSourceCollectionHandler,
  createRefreshSourceCollectionHandler,
  createListSourceCollectionsHandler,
  type SourceCollectionsRouteDeps,
} from "../src/http/routes/sourceCollections.js";
import { createAddDiscordSourceHandler, type ProjectSourcesRouteDeps } from "../src/http/routes/projectSources.js";
import { DiscordAttachmentDownloadError } from "../src/discord/downloadDiscordAttachment.js";
import { upsertDiscordGuild } from "../src/db/discordGuildsRepo.js";
import { getSourceCollectionById } from "../src/db/sourceCollectionsRepo.js";
import { getProjectSourceById } from "../src/db/projectSourcesRepo.js";
import { getProjectSourceMedia } from "../src/db/projectSourceMediaRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BOT_TOKEN = "test-bot-token";

function deps(overrides: Partial<SourceCollectionsRouteDeps> = {}): SourceCollectionsRouteDeps {
  return { pool, discordBotToken: BOT_TOKEN, ...overrides };
}

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function callImport(projectId: string, guildId: number, channelIds: string[], d: DiscordChannelsRouteDeps = deps()) {
  const handler = createImportDiscordChannelsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { guildId, channelIds } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callRefresh(projectId: string, collectionId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createRefreshSourceCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callGet(projectId: string, collectionId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createGetSourceCollectionHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId, collectionId }, query: {} } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callList(projectId: string, d: SourceCollectionsRouteDeps = deps()) {
  const handler = createListSourceCollectionsHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

function callAddAlaCarteDiscord(projectId: string, url: string, d: ProjectSourcesRouteDeps = { pool }) {
  const handler = createAddDiscordSourceHandler(d);
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { url } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as Record<string, unknown> }));
}

interface FixtureMessage {
  id: string;
  attachments: Array<{ id: string; filename: string; url: string; size: number }>;
}

interface FixtureChannel {
  id: string;
  name: string;
  type: number;
  parentId?: string | null;
}

/** Simulates GET /guilds/{id}/channels and GET /channels/{id}/messages (paginated, per-channel) for the Discord REST API. */
function stubDiscordGuild(guildId: string, channels: FixtureChannel[], messagesByChannel: Record<string, FixtureMessage[]> = {}, pageSize = 50) {
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/api/v10/guilds/${guildId}/channels`) {
      return jsonResponse(200, channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parent_id: c.parentId ?? null })));
    }
    const messagesMatch = parsed.pathname.match(/^\/api\/v10\/channels\/([^/]+)\/messages$/);
    if (messagesMatch) {
      const channelId = messagesMatch[1];
      const messages = messagesByChannel[channelId] ?? [];
      const before = parsed.searchParams.get("before");
      let startIdx = 0;
      if (before) {
        const idx = messages.findIndex((m) => m.id === before);
        startIdx = idx === -1 ? messages.length : idx + 1;
      }
      return jsonResponse(200, messages.slice(startIdx, startIdx + pageSize));
    }
    return jsonResponse(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fakeDownloader(failFor: Set<string> = new Set()) {
  return vi.fn(async (sourceUrl: string) => {
    if (failFor.has(sourceUrl)) throw new DiscordAttachmentDownloadError("simulated download failure");
    return { content: Buffer.from(`bytes-for-${sourceUrl}`), contentType: "video/mp4", byteSize: 10 };
  });
}

function videoMessages(base: number, count: number): FixtureMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i;
    const id = String(base + n);
    const attId = String(base + 1_000_000 + n);
    return { id, attachments: [{ id: attId, filename: `clip${n}.mp4`, url: `https://cdn.discordapp.com/attachments/1/${attId}/clip${n}.mp4?ex=1`, size: 100 }] };
  });
}

describe("POST /api/projects/:projectId/collections/discord/import", () => {
  it("imports multiple explicitly-selected channels, discovers their video attachments, and never auto-analyzes", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const channels: FixtureChannel[] = [
      { id: "100", name: "trade-reviews", type: 0 },
      { id: "200", name: "announcements", type: 5 },
    ];
    stubDiscordGuild(guild.guildId, channels, { "100": videoMessages(1_000_000, 2), "200": videoMessages(2_000_000, 1) });

    const { statusCode, body } = await callImport(String(project.id), guild.id, ["100", "200"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    expect(statusCode).toBe(201);
    const results = body.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.kind === "imported")).toBe(true);
    expect(results.find((r) => r.channelId === "100")?.importedCount).toBe(2);
    expect(results.find((r) => r.channelId === "200")?.importedCount).toBe(1);

    const jobCount = await pool.query(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj JOIN project_sources ps ON ps.id = psaj.project_source_id WHERE ps.project_id = $1`,
      [project.id],
    );
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });

  it("never auto-imports channels the caller did not select — only the requested channelIds become collections", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const channels: FixtureChannel[] = [
      { id: "100", name: "trade-reviews", type: 0 },
      { id: "300", name: "off-topic", type: 0 },
    ];
    stubDiscordGuild(guild.guildId, channels, { "100": videoMessages(3_000_000, 1), "300": videoMessages(4_000_000, 1) });

    await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const { body: listBody } = await callList(String(project.id));
    const collections = listBody.collections as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(1);
    expect(collections[0].externalId).toBe("100");
  });

  it("a nonexistent channel id in the selection is reported invalid; other valid channels in the same request still succeed (partial success)", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(5_000_000, 1) });

    const { statusCode, body } = await callImport(String(project.id), guild.id, ["100", "does-not-exist"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    expect(statusCode).toBe(201);
    const results = body.results as Array<Record<string, unknown>>;
    expect(results.find((r) => r.channelId === "100")?.kind).toBe("imported");
    expect(results.find((r) => r.channelId === "does-not-exist")?.kind).toBe("invalid");
  });

  it("a non-text-capable (voice) channel id is rejected as invalid, never presented as importable", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "500", name: "General VC", type: 2 }]);

    const { body } = await callImport(String(project.id), guild.id, ["500"], deps());
    const results = body.results as Array<Record<string, unknown>>;
    expect(results[0].kind).toBe("invalid");
  });

  it("an unknown or disconnected guild 404s", async () => {
    const project = await makeProject();
    const { statusCode } = await callImport(String(project.id), 999999999, ["100"], deps());
    expect(statusCode).toBe(404);
  });

  it("responds 501 when DISCORD_BOT_TOKEN isn't configured, never calling the Discord API", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { statusCode } = await callImport(String(project.id), guild.id, ["100"], deps({ discordBotToken: undefined }));
    expect(statusCode).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selecting the same channel across two import calls is idempotent at the collection level — no duplicate collection, adopts already-discovered items", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(6_000_000, 1) });

    const first = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const second = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    expect((first.body.results as Array<Record<string, unknown>>)[0].collection).toEqual((second.body.results as Array<Record<string, unknown>>)[0].collection);
    expect((second.body.results as Array<Record<string, unknown>>)[0].adoptedCount).toBe(1);
    expect((second.body.results as Array<Record<string, unknown>>)[0].importedCount).toBe(0);

    const { body: listBody } = await callList(String(project.id));
    expect((listBody.collections as unknown[]).length).toBe(1);
  });
});

describe("POST /api/projects/:projectId/collections/:collectionId/refresh — Discord dispatch (Phase 4K-B)", () => {
  it("refresh re-discovers newer attachments, preserves existing items, and never duplicates on a second idempotent refresh", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(7_000_000, 1) });
    const { body: imported } = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const collectionId = ((imported.results as Array<Record<string, unknown>>)[0].collection as Record<string, unknown>).id as number;

    // A newer attachment has appeared since import.
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(7_000_000, 2) });
    const refreshOne = await callRefresh(String(project.id), String(collectionId), deps({ downloadDiscordAttachment: fakeDownloader() }));
    expect(refreshOne.statusCode).toBe(200);
    expect(refreshOne.body.importedCount).toBe(1);
    expect(refreshOne.body.adoptedCount).toBe(1);

    const refreshTwoFetch = stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(7_000_000, 2) });
    const refreshTwo = await callRefresh(String(project.id), String(collectionId), deps({ downloadDiscordAttachment: fakeDownloader() }));
    expect(refreshTwo.body.importedCount).toBe(0);
    expect(refreshTwo.body.adoptedCount).toBe(2); // only the first (fully-known) page re-checked before stopping
    const messagesCalls = refreshTwoFetch.mock.calls.filter(([url]) => (url as string).includes("/messages")).length;
    expect(messagesCalls).toBe(1);

    const { body: detail } = await callGet(String(project.id), String(collectionId));
    expect((detail.items as unknown[]).length).toBe(2);
  });

  it("a channel deeper than the per-call page cap leaves hasMoreHistory=true, reaching full history via subsequent refreshes, never auto-analyzing", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "deep-channel", type: 0 }], { "100": videoMessages(8_000_000, 30) }, 10);

    const { body: imported } = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader(), discordDiscoveryMaxPagesPerCall: 1 }));
    const result = (imported.results as Array<Record<string, unknown>>)[0];
    expect(result.importedCount).toBe(10);
    expect(result.hasMoreHistory).toBe(true);
    const collectionId = (result.collection as Record<string, unknown>).id as number;

    const refreshOne = await callRefresh(String(project.id), String(collectionId), deps({ downloadDiscordAttachment: fakeDownloader(), discordDiscoveryMaxPagesPerCall: 1 }));
    expect(refreshOne.body.importedCount).toBe(10);
    expect(refreshOne.body.hasMoreHistory).toBe(true);

    const refreshTwo = await callRefresh(String(project.id), String(collectionId), deps({ downloadDiscordAttachment: fakeDownloader(), discordDiscoveryMaxPagesPerCall: 1 }));
    expect(refreshTwo.body.importedCount).toBe(10);
    // The final page returned exactly pageSize (10) items — a full page never proves history is exhausted (only an empty page does), so the cursor is still non-null here.
    expect(refreshTwo.body.hasMoreHistory).toBe(true);

    const refreshThree = await callRefresh(String(project.id), String(collectionId), deps({ downloadDiscordAttachment: fakeDownloader(), discordDiscoveryMaxPagesPerCall: 1 }));
    expect(refreshThree.body.importedCount).toBe(0);
    expect(refreshThree.body.hasMoreHistory).toBe(false);

    const { body: detail } = await callGet(String(project.id), String(collectionId), deps());
    expect((detail.pagination as Record<string, unknown>).totalCount).toBe(30);

    const jobCount = await pool.query(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj JOIN project_sources ps ON ps.id = psaj.project_source_id WHERE ps.collection_id = $1`,
      [collectionId],
    );
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });
});

describe("Discord catalog — project isolation at the HTTP layer (Phase 4K-B)", () => {
  it("the SAME Discord channel imported into two different projects produces independent, isolated collections/items", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Shared Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(9_000_000, 1) });

    const resultA = await callImport(String(projectA.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const resultB = await callImport(String(projectB.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const collectionIdA = ((resultA.body.results as Array<Record<string, unknown>>)[0].collection as Record<string, unknown>).id as number;
    const collectionIdB = ((resultB.body.results as Array<Record<string, unknown>>)[0].collection as Record<string, unknown>).id as number;
    expect(collectionIdA).not.toBe(collectionIdB);

    // Project B can never read or refresh Project A's collection through the HTTP layer.
    const crossGet = await callGet(String(projectB.id), String(collectionIdA));
    expect(crossGet.statusCode).toBe(404);
    const crossRefresh = await callRefresh(String(projectB.id), String(collectionIdA));
    expect(crossRefresh.statusCode).toBe(404);

    const { body: listA } = await callList(String(projectA.id));
    expect((listA.collections as unknown[]).length).toBe(1);
    const { body: listB } = await callList(String(projectB.id));
    expect((listB.collections as unknown[]).length).toBe(1);
  });
});

describe("Discord dedup — HTTP layer, both directions (Phase 4K-B)", () => {
  it("à-la-carte import FIRST, then the same attachment is discovered via channel import — adopted, no duplicate media/source, collection association added", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const alaCarteUrl = "https://cdn.discordapp.com/attachments/1/10000001/clip.mp4?ex=old";
    const { statusCode: alaCarteStatus, body: alaCarteBody } = await callAddAlaCarteDiscord(String(project.id), alaCarteUrl, { pool, downloadDiscordAttachment: fakeDownloader() });
    expect(alaCarteStatus).toBe(201);
    const alaCarteSourceId = (alaCarteBody.source as Record<string, unknown>).id as number;

    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], {
      "100": [{ id: "20000001", attachments: [{ id: "10000001", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/10000001/clip.mp4?ex=fresh", size: 50 }] }],
    });
    const downloader = fakeDownloader();
    const { body } = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: downloader }));
    const result = (body.results as Array<Record<string, unknown>>)[0];
    expect(result.adoptedCount).toBe(1);
    expect(result.importedCount).toBe(0);
    expect(downloader).not.toHaveBeenCalled(); // already-captured media is never re-downloaded

    const adopted = await getProjectSourceById(pool, alaCarteSourceId);
    expect(adopted?.collectionId).toBe((result.collection as Record<string, unknown>).id);
    const sourceCount = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE project_id = $1`, [project.id]);
    expect(Number((sourceCount.rows[0] as { count: string }).count)).toBe(1); // never duplicated
  });

  it("channel import FIRST, then the SAME attachment is pasted à-la-carte — reused, no second source/media row created", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], {
      "100": [{ id: "20000002", attachments: [{ id: "10000002", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/10000002/clip.mp4?ex=1", size: 50 }] }],
    });
    const { body: imported } = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const collectionId = ((imported.results as Array<Record<string, unknown>>)[0].collection as Record<string, unknown>).id as number;
    const beforeMedia = await pool.query(`SELECT ps.id FROM project_sources ps WHERE ps.collection_id = $1`, [collectionId]);
    const originalSourceId = Number((beforeMedia.rows[0] as { id: string }).id);
    const originalMedia = await getProjectSourceMedia(pool, originalSourceId);

    const { statusCode, body } = await callAddAlaCarteDiscord(String(project.id), "https://cdn.discordapp.com/attachments/1/10000002/clip.mp4?ex=another", { pool, downloadDiscordAttachment: fakeDownloader() });
    expect(statusCode).toBe(200); // reused an existing source, not a fresh creation
    expect(body.duplicate).toBe(true);
    expect((body.source as Record<string, unknown>).id).toBe(originalSourceId); // reused, not a new row

    const sourceCount = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE project_id = $1`, [project.id]);
    expect(Number((sourceCount.rows[0] as { count: string }).count)).toBe(1);
    const mediaAfter = await getProjectSourceMedia(pool, originalSourceId);
    expect(mediaAfter?.content.toString()).toBe(originalMedia?.content.toString()); // original durable media untouched
  });
});

describe("Discord connection-loss / API failure handling (Phase 4K-B)", () => {
  it("a 403 (bot lacks access to list guild channels) fails the whole import cleanly with a sanitized error, creating no collections", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { message: "Missing Access" })));

    const { statusCode, body } = await callImport(String(project.id), guild.id, ["100"], deps());
    expect(statusCode).toBe(502);
    expect((body.error as Record<string, unknown>).message).not.toContain(BOT_TOKEN);

    const { body: listBody } = await callList(String(project.id));
    expect((listBody.collections as unknown[]).length).toBe(0);
  });

  it("a per-channel discovery failure (429 exhausted) marks that channel's collection SYNC_FAILED with a sanitized error, reported invalid in the response — other channels in the same request are unaffected", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === `/api/v10/guilds/${guild.guildId}/channels`) {
        return jsonResponse(200, [
          { id: "100", name: "flaky-channel", type: 0, parent_id: null },
          { id: "200", name: "healthy-channel", type: 0, parent_id: null },
        ]);
      }
      if (parsed.pathname === "/api/v10/channels/100/messages") return jsonResponse(429, { message: "rate limited", retry_after: 0.01 });
      if (parsed.pathname === "/api/v10/channels/200/messages") return jsonResponse(200, []);
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const { statusCode, body } = await callImport(String(project.id), guild.id, ["100", "200"], deps());
    expect(statusCode).toBe(201);
    const results = body.results as Array<Record<string, unknown>>;
    const flaky = results.find((r) => r.channelId === "100")!;
    expect(flaky.kind).toBe("invalid");
    expect(flaky.message).not.toContain(BOT_TOKEN);
    const healthy = results.find((r) => r.channelId === "200")!;
    expect(healthy.kind).toBe("imported");

    const flakyCollection = await pool.query(`SELECT status, sanitized_error FROM source_collections WHERE project_id = $1 AND external_id = '100'`, [project.id]);
    expect((flakyCollection.rows[0] as { status: string }).status).toBe("SYNC_FAILED");
  });

  it("a refresh failure (401 — bot token invalidated / revoked) fails cleanly with a sanitized error, leaving the existing catalog completely intact", async () => {
    const project = await makeProject();
    const guild = await upsertDiscordGuild(pool, randomId("guild"), "Trading Community");
    stubDiscordGuild(guild.guildId, [{ id: "100", name: "trade-reviews", type: 0 }], { "100": videoMessages(11_000_000, 1) });
    const { body: imported } = await callImport(String(project.id), guild.id, ["100"], deps({ downloadDiscordAttachment: fakeDownloader() }));
    const collectionId = ((imported.results as Array<Record<string, unknown>>)[0].collection as Record<string, unknown>).id as number;

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "Unauthorized" })));
    const { statusCode, body } = await callRefresh(String(project.id), String(collectionId));
    expect(statusCode).toBe(502);
    expect((body.error as Record<string, unknown>).message).not.toContain(BOT_TOKEN);

    const collectionAfter = await getSourceCollectionById(pool, collectionId);
    expect(collectionAfter?.status).toBe("SYNC_FAILED");
    const { body: detail } = await callGet(String(project.id), String(collectionId));
    expect((detail.items as unknown[]).length).toBe(1); // the previously-imported item is untouched
  });
});
