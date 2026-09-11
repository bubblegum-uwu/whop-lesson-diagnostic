import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { discoverAndImportDiscordChannelPages } from "../src/discord/discordChannelDiscovery.js";
import { DiscordAttachmentDownloadError } from "../src/discord/downloadDiscordAttachment.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { createDiscordSource, getProjectSourceById } from "../src/db/projectSourcesRepo.js";
import { getProjectSourceMedia } from "../src/db/projectSourceMediaRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = "test-bot-token";

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeCollection(projectId: number, channelId: string): Promise<number> {
  const { collection } = await createSourceCollection(pool, { projectId, provider: "DISCORD", externalId: channelId, title: "#trade-reviews", sourceUrl: `https://discord.com/channels/g/${channelId}` });
  return collection.id;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface FixtureMessage {
  id: string;
  attachments: Array<{ id: string; filename: string; url: string; size: number; content_type?: string }>;
}

/**
 * Newest-first message list — index 0 has the highest numeric id, matching Discord's own
 * ordering. IDs must be purely numeric (real Discord snowflakes are) since `parseDiscordVideoUrl`
 * requires the attachment-id URL path segment to match `SNOWFLAKE_PATTERN = /^[0-9]{1,20}$/`.
 * `base` should be a distinct range per test to avoid id collisions across fixtures.
 */
function makeVideoMessages(base: number, count: number): FixtureMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const n = count - i;
    const id = String(base + n);
    const attId = String(base + 1_000_000 + n);
    return { id, attachments: [{ id: attId, filename: `clip${n}.mp4`, url: `https://cdn.discordapp.com/attachments/1/${attId}/clip${n}.mp4?ex=1`, size: 100 }] };
  });
}

function stubDiscordMessages(channelId: string, messages: FixtureMessage[], pageSize = 50) {
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith(`/channels/${channelId}/messages`)) return jsonResponse(404, {});
    const before = parsed.searchParams.get("before");
    let startIdx = 0;
    if (before) {
      const idx = messages.findIndex((m) => m.id === before);
      startIdx = idx === -1 ? messages.length : idx + 1;
    }
    return jsonResponse(200, messages.slice(startIdx, startIdx + pageSize));
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

describe("discoverAndImportDiscordChannelPages (Phase 4K-B)", () => {
  it("discovers well beyond position 15 in a single call (small provider page size, well under the maxPages cap)", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const messages = makeVideoMessages(10_000_000, 60);
    stubDiscordMessages(channelId, messages, 5);

    const result = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      earlyStopOnFullyKnownPage: false,
      downloadDiscordAttachment: fakeDownloader(),
    });
    expect(result.discoveredCount).toBe(60);
    expect(result.importedCount).toBe(60);
    expect(result.nextBeforeMessageId).toBeNull();

    const countResult = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(Number((countResult.rows[0] as { count: string }).count)).toBe(60);
  });

  it("a channel deeper than the per-call page cap leaves a cursor, reaching the rest via subsequent calls", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const messages = makeVideoMessages(20_000_000, 30); // 3 provider pages of 10 with pageSize:10
    stubDiscordMessages(channelId, messages, 10);

    const first = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      earlyStopOnFullyKnownPage: false,
      maxPages: 1,
      downloadDiscordAttachment: fakeDownloader(),
    });
    expect(first.importedCount).toBe(10);
    expect(first.nextBeforeMessageId).not.toBeNull();

    const second = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      startBeforeMessageId: first.nextBeforeMessageId,
      earlyStopOnFullyKnownPage: false,
      maxPages: 1,
      downloadDiscordAttachment: fakeDownloader(),
    });
    expect(second.importedCount).toBe(10);
    expect(second.nextBeforeMessageId).not.toBeNull();

    const third = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      startBeforeMessageId: second.nextBeforeMessageId,
      earlyStopOnFullyKnownPage: false,
      maxPages: 1,
      downloadDiscordAttachment: fakeDownloader(),
    });
    expect(third.importedCount).toBe(10);
    // A full (non-empty) page never proves history is exhausted — Discord's own pagination
    // contract only signals "done" via an empty page, so the cursor must still be non-null here.
    expect(third.nextBeforeMessageId).not.toBeNull();

    const fourth = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      startBeforeMessageId: third.nextBeforeMessageId,
      earlyStopOnFullyKnownPage: false,
      maxPages: 1,
      downloadDiscordAttachment: fakeDownloader(),
    });
    expect(fourth.importedCount).toBe(0);
    expect(fourth.nextBeforeMessageId).toBeNull(); // the empty page unambiguously reached the actual start of history

    const countResult = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(Number((countResult.rows[0] as { count: string }).count)).toBe(30);
  });

  it("refresh (earlyStopOnFullyKnownPage) stops at the first fully-known page, creating zero duplicates", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const messages = makeVideoMessages(30_000_000, 20);
    stubDiscordMessages(channelId, messages, 5);
    await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, { earlyStopOnFullyKnownPage: false, downloadDiscordAttachment: fakeDownloader() });

    const refreshFetch = stubDiscordMessages(channelId, messages, 5);
    const refresh = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, { earlyStopOnFullyKnownPage: true, downloadDiscordAttachment: fakeDownloader() });
    expect(refresh.importedCount).toBe(0);
    expect(refresh.adoptedCount).toBe(5); // only the first page (5 attachments) re-checked before stopping
    expect(refreshFetch).toHaveBeenCalledTimes(1);

    const countResult = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(Number((countResult.rows[0] as { count: string }).count)).toBe(20);
  });

  it("unsupported attachment types (non-video) are silently omitted from the catalog, never counted or imported", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const messages: FixtureMessage[] = [
      { id: "50000003", attachments: [{ id: "50100003", filename: "screenshot.png", url: "https://cdn.discordapp.com/attachments/1/50100003/screenshot.png?ex=1", size: 50 }] },
      { id: "50000002", attachments: [{ id: "50100002", filename: "notes.pdf", url: "https://cdn.discordapp.com/attachments/1/50100002/notes.pdf?ex=1", size: 50 }] },
      { id: "50000001", attachments: [{ id: "50100001", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/50100001/clip.mp4?ex=1", size: 50 }] },
    ];
    stubDiscordMessages(channelId, messages, 50);

    const result = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, { earlyStopOnFullyKnownPage: false, downloadDiscordAttachment: fakeDownloader() });
    expect(result.discoveredCount).toBe(1);
    expect(result.importedCount).toBe(1);

    const rows = await pool.query(`SELECT external_id FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(rows.rows.map((r) => (r as { external_id: string }).external_id)).toEqual(["50100001"]);
  });

  it("a download failure rolls back the row (compensating delete), never leaving a half-imported source", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const failUrl = "https://cdn.discordapp.com/attachments/1/60100001/fail.mp4?ex=1";
    const messages: FixtureMessage[] = [{ id: "60000001", attachments: [{ id: "60100001", filename: "fail.mp4", url: failUrl, size: 50 }] }];
    stubDiscordMessages(channelId, messages, 50);

    const result = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, {
      earlyStopOnFullyKnownPage: false,
      downloadDiscordAttachment: fakeDownloader(new Set([failUrl])),
    });
    expect(result.importedCount).toBe(0);
    expect(result.failedCount).toBe(1);

    const rows = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE collection_id = $1`, [collectionId]);
    expect(Number((rows.rows[0] as { count: string }).count)).toBe(0);
  });

  it("DEDUP: an attachment already imported à la carte is ADOPTED (not re-downloaded), analysis preserved", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const { source: alaCarte } = await createDiscordSource(pool, {
      projectId: project.id,
      externalId: "70100001",
      sourceUrl: "https://cdn.discordapp.com/attachments/1/70100001/clip.mp4?ex=old",
    });
    await pool.query(`INSERT INTO project_source_media (project_source_id, content, content_type, byte_size) VALUES ($1, $2, 'video/mp4', 4)`, [alaCarte.id, Buffer.from("orig")]);

    const messages: FixtureMessage[] = [{ id: "70000001", attachments: [{ id: "70100001", filename: "clip.mp4", url: "https://cdn.discordapp.com/attachments/1/70100001/clip.mp4?ex=fresh", size: 50 }] }];
    stubDiscordMessages(channelId, messages, 50);
    const downloader = fakeDownloader();

    const result = await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, { earlyStopOnFullyKnownPage: false, downloadDiscordAttachment: downloader });
    expect(result.adoptedCount).toBe(1);
    expect(result.importedCount).toBe(0);
    expect(downloader).not.toHaveBeenCalled(); // already-captured media is never re-downloaded

    const adopted = await getProjectSourceById(pool, alaCarte.id);
    expect(adopted?.collectionId).toBe(collectionId); // linked into the collection
    const media = await getProjectSourceMedia(pool, alaCarte.id);
    expect(media?.content.toString()).toBe("orig"); // original media untouched, never overwritten
  });

  it("never enqueues analysis for newly-discovered or adopted attachments", async () => {
    const project = await makeProject();
    const channelId = randomId("chan");
    const collectionId = await makeCollection(project.id, channelId);
    const messages = makeVideoMessages(40_000_000, 3);
    stubDiscordMessages(channelId, messages, 50);

    await discoverAndImportDiscordChannelPages(pool, project.id, collectionId, channelId, TOKEN, { earlyStopOnFullyKnownPage: false, downloadDiscordAttachment: fakeDownloader() });

    const jobCount = await pool.query(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj JOIN project_sources ps ON ps.id = psaj.project_source_id WHERE ps.collection_id = $1`,
      [collectionId],
    );
    expect(Number((jobCount.rows[0] as { count: string }).count)).toBe(0);
  });
});
