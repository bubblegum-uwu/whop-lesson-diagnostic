import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import {
  createDiscordImportYouTubeSourcesHandler,
  createAddYouTubeSourceHandler,
  type DiscordImportResponse,
  type YouTubeProjectSource,
} from "../src/http/routes/projectSources.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

interface TestProject {
  id: number;
}

async function makeProject(): Promise<TestProject> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, project_type) VALUES ($1, 'GENERAL_KNOWLEDGE') RETURNING id`,
    [name],
  );
  return { id: Number(result.rows[0].id) };
}

const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YOUTUBE_URL_2 = "https://www.youtube.com/watch?v=AbCdEfGhIjK";

function channel(overrides: Partial<{ guildId: string; channelId: string; channelName: string | null }> = {}) {
  return {
    guildId: "1218766394997346395",
    channelId: "1219022089252503632",
    channelName: "pre-market-live",
    ...overrides,
  };
}

function occurrence(overrides: Partial<{ youtubeUrl: string; messageId: string; messageUrl: string | null; postedAt: string }> = {}) {
  return {
    youtubeUrl: YOUTUBE_URL,
    messageId: randomId("msg"),
    messageUrl: "https://discord.com/channels/1218766394997346395/1219022089252503632/1219022089252503999",
    postedAt: "2026-09-12T14:30:00.000Z",
    ...overrides,
  };
}

async function callImportHandler(projectId: string, channelBody: unknown, occurrences: unknown) {
  const handler = createDiscordImportYouTubeSourcesHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId }, body: { channel: channelBody, occurrences } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as DiscordImportResponse & { error?: { type: string; message: string } } };
}

async function callAddYouTubeHandler(projectId: string, url: unknown) {
  const handler = createAddYouTubeSourceHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  await handler({ params: { projectId }, body: { url } } as unknown as Request, res);
  return { statusCode: statusCode(), body: body() as { source?: YouTubeProjectSource; duplicate?: boolean } };
}

async function countAnalysisJobsForSource(sourceId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM project_source_analysis_jobs WHERE project_source_id = $1`,
    [sourceId],
  );
  return Number(result.rows[0].count);
}

describe("POST /api/projects/:projectId/sources/youtube/discord-import (Phase 4K-C)", () => {
  it("1: a Discord-imported YouTube URL creates a YOUTUBE project_source", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callImportHandler(String(project.id), channel(), [occurrence()]);

    expect(statusCode).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].kind).toBe("added");
    expect(body.results[0].source?.provider).toBe("YOUTUBE");
    expect(body.results[0].source?.externalId).toBe("dQw4w9WgXcQ");
    expect(body.results[0].source?.status).toBe("READY");
    expect(body.newSourceCount).toBe(1);
  });

  it("2: creates a Discord provenance record with channel/message/posted timestamp", async () => {
    const project = await makeProject();
    const occ = occurrence({ messageId: "msg-100", postedAt: "2026-09-12T14:30:00.000Z" });
    const { body } = await callImportHandler(String(project.id), channel({ channelName: "pre-market-live" }), [occ]);

    const origins = body.results[0].source!.origins;
    expect(origins).toHaveLength(1);
    expect(origins[0].originType).toBe("DISCORD_CHANNEL");
    expect(origins[0].discordChannelId).toBe("1219022089252503632");
    expect(origins[0].discordChannelName).toBe("pre-market-live");
    expect(origins[0].discordMessageId).toBe("msg-100");
    expect(new Date(origins[0].discordPostedAt!).toISOString()).toBe("2026-09-12T14:30:00.000Z");
  });

  it("3: never creates an analysis job — the imported source stays NOT_ANALYZED/unqueued", async () => {
    const project = await makeProject();
    const { body } = await callImportHandler(String(project.id), channel(), [occurrence()]);
    const sourceId = body.results[0].source!.id;

    expect(await countAnalysisJobsForSource(sourceId)).toBe(0);
    expect(body.results[0].source!.status).toBe("READY");
  });

  it("4: the same video appearing twice (different messages) does not duplicate the project_source", async () => {
    const project = await makeProject();
    const { body } = await callImportHandler(String(project.id), channel(), [
      occurrence({ messageId: "m1" }),
      occurrence({ messageId: "m2" }),
    ]);

    expect(body.results[0].source!.id).toBe(body.results[1].source!.id);
    expect(body.results[0].kind).toBe("added");
    expect(body.results[1].kind).toBe("existing_source_new_origin");
    expect(body.newSourceCount).toBe(1);
    expect(body.newOriginCount).toBe(1);
  });

  it("5: different Discord message occurrences for the same video are both preserved as separate origins", async () => {
    const project = await makeProject();
    const { body } = await callImportHandler(String(project.id), channel(), [
      occurrence({ messageId: "m1" }),
      occurrence({ messageId: "m2" }),
    ]);

    const sourceId = body.results[0].source!.id;
    const origins = body.results[1].source!.origins;
    expect(origins.filter((o) => o.discordMessageId === "m1" || o.discordMessageId === "m2")).toHaveLength(2);
    expect(body.results[1].source!.id).toBe(sourceId);
  });

  it("6: re-importing the exact same Discord message occurrence is idempotent (no duplicate origin row)", async () => {
    const project = await makeProject();
    const occ = occurrence({ messageId: "m-repeat" });
    const first = await callImportHandler(String(project.id), channel(), [occ]);
    const second = await callImportHandler(String(project.id), channel(), [occ]);

    expect(first.body.results[0].kind).toBe("added");
    expect(second.body.results[0].kind).toBe("duplicate_origin");
    expect(second.body.results[0].source!.origins).toHaveLength(1);
    expect(second.body.duplicateOriginCount).toBe(1);
  });

  it("7: the same video across two different Discord channels → one source, two provenance records", async () => {
    const project = await makeProject();
    const first = await callImportHandler(String(project.id), channel({ channelId: "channel-a" }), [occurrence({ messageId: "m1" })]);
    const second = await callImportHandler(String(project.id), channel({ channelId: "channel-b" }), [occurrence({ messageId: "m1" })]);

    expect(first.body.results[0].source!.id).toBe(second.body.results[0].source!.id);
    expect(second.body.results[0].kind).toBe("existing_source_new_origin");
    expect(second.body.results[0].source!.origins).toHaveLength(2);
    const channelIds = second.body.results[0].source!.origins.map((o) => o.discordChannelId).sort();
    expect(channelIds).toEqual(["channel-a", "channel-b"]);
  });

  it("8: a manual add creates a MANUAL provenance record", async () => {
    const project = await makeProject();
    const { body } = await callAddYouTubeHandler(String(project.id), YOUTUBE_URL);

    expect(body.source?.origins).toHaveLength(1);
    expect(body.source?.origins[0].originType).toBe("MANUAL");
    expect(body.source?.origins[0].discordChannelId).toBeNull();
  });

  it("9: an existing Discord-origin source + later manual add stays one source and gains a MANUAL origin", async () => {
    const project = await makeProject();
    const imported = await callImportHandler(String(project.id), channel(), [occurrence()]);
    const manual = await callAddYouTubeHandler(String(project.id), YOUTUBE_URL);

    expect(manual.body.source?.id).toBe(imported.body.results[0].source!.id);
    expect(manual.body.duplicate).toBe(true);
    const originTypes = manual.body.source!.origins.map((o) => o.originType).sort();
    expect(originTypes).toEqual(["DISCORD_CHANNEL", "MANUAL"]);
  });

  it("10: an existing manual source + later Discord discovery stays one source and gains a Discord origin", async () => {
    const project = await makeProject();
    const manual = await callAddYouTubeHandler(String(project.id), YOUTUBE_URL);
    const imported = await callImportHandler(String(project.id), channel(), [occurrence()]);

    expect(imported.body.results[0].source!.id).toBe(manual.body.source!.id);
    expect(imported.body.results[0].kind).toBe("existing_source_new_origin");
    const originTypes = imported.body.results[0].source!.origins.map((o) => o.originType).sort();
    expect(originTypes).toEqual(["DISCORD_CHANNEL", "MANUAL"]);
  });

  it("11: invalid Discord posted timestamps are rejected as invalid, not silently coerced", async () => {
    const project = await makeProject();
    const { body } = await callImportHandler(String(project.id), channel(), [
      occurrence({ postedAt: "not-a-timestamp" }),
      occurrence({ messageId: "m-missing-posted-at", postedAt: undefined as unknown as string }),
    ]);

    expect(body.results[0].kind).toBe("invalid");
    expect(body.results[1].kind).toBe("invalid");
    expect(body.invalidCount).toBe(2);
  });

  it("12: invalid YouTube URLs are rejected and partial failures follow existing batch conventions", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callImportHandler(String(project.id), channel(), [
      occurrence({ youtubeUrl: "https://vimeo.com/12345", messageId: "bad-1" }),
      occurrence({ youtubeUrl: YOUTUBE_URL_2, messageId: "good-1" }),
    ]);

    expect(statusCode).toBe(200);
    expect(body.results[0].kind).toBe("invalid");
    expect(body.results[0].message).toBeTruthy();
    expect(body.results[1].kind).toBe("added");
    expect(body.invalidCount).toBe(1);
    expect(body.newSourceCount).toBe(1);
  });

  it("13: provenance is scoped correctly to its own project source, not leaked to a same-video source in another project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const inA = await callImportHandler(String(projectA.id), channel(), [occurrence({ messageId: "m-a" })]);
    const inB = await callImportHandler(String(projectB.id), channel(), [occurrence({ messageId: "m-b" })]);

    expect(inA.body.results[0].source!.id).not.toBe(inB.body.results[0].source!.id);
    expect(inA.body.results[0].source!.origins.map((o) => o.discordMessageId)).toEqual(["m-a"]);
    expect(inB.body.results[0].source!.origins.map((o) => o.discordMessageId)).toEqual(["m-b"]);
  });

  it("14: no cross-project provenance leakage via GET /sources for an unrelated project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await callImportHandler(String(projectA.id), channel(), [occurrence()]);

    const { createGetProjectSourcesHandler } = await import("../src/http/routes/projectSources.js");
    const handler = createGetProjectSourcesHandler({ pool });
    const { res, body } = makeResponse();
    await handler({ params: { projectId: String(projectB.id) } } as unknown as Request, res);
    expect((body() as { sources: unknown[] }).sources).toEqual([]);
  });

  it("rejects a request missing channel.guildId/channelId with a deterministic 400", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callImportHandler(String(project.id), { channelId: "c1" }, [occurrence()]);
    expect(statusCode).toBe(400);
    expect(body.error?.type).toBe("invalid_request");
  });

  it("rejects an empty occurrences array with a deterministic 400", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callImportHandler(String(project.id), channel(), []);
    expect(statusCode).toBe(400);
    expect(body.error?.type).toBe("invalid_request");
  });

  it("returns a deterministic 404 for an unknown project", async () => {
    const { statusCode, body } = await callImportHandler("999999999", channel(), [occurrence()]);
    expect(statusCode).toBe(404);
    expect(body.error?.type).toBe("project_not_found");
  });
});
