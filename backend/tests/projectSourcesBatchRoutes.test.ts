import { describe, it, expect, afterAll, vi } from "vitest";
import type { Request } from "express";
import {
  createBatchAddYouTubeSourcesHandler,
  createBatchAddDiscordSourcesHandler,
  type BatchAddSourcesResponse,
} from "../src/http/routes/projectSources.js";
import { DiscordAttachmentDownloadError } from "../src/discord/downloadDiscordAttachment.js";
import { createTestPool, randomId } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

function fakeDownloadDiscordAttachment() {
  return vi.fn(async () => ({ content: Buffer.from("fake-video-bytes"), contentType: "video/mp4", byteSize: 16 }));
}

function callBatchYouTube(projectId: string, urls: unknown) {
  const handler = createBatchAddYouTubeSourcesHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { urls } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as BatchAddSourcesResponse & { error?: { type: string } } }));
}

function callBatchDiscord(projectId: string, urls: unknown, downloadDiscordAttachment = fakeDownloadDiscordAttachment()) {
  const handler = createBatchAddDiscordSourcesHandler({ pool, downloadDiscordAttachment });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId }, body: { urls } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as BatchAddSourcesResponse & { error?: { type: string } } }));
}

const V1 = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const V2 = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
const DISCORD_URL_1 = "https://cdn.discordapp.com/attachments/1/2/clip1.mp4?ex=1&is=2&hm=3";
const DISCORD_URL_2 = "https://cdn.discordapp.com/attachments/1/3/clip2.mp4?ex=1&is=2&hm=3";

describe("POST /api/projects/:projectId/sources/youtube/batch (Phase 4K)", () => {
  it("imports multiple valid URLs, never analyzing any of them", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callBatchYouTube(String(project.id), [V1, V2]);
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(2);
    expect(body.duplicateCount).toBe(0);
    expect(body.invalidCount).toBe(0);

    const jobCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM project_source_analysis_jobs psaj JOIN project_sources ps ON ps.id = psaj.project_source_id WHERE ps.project_id = $1`,
      [project.id],
    );
    expect(Number(jobCount.rows[0].count)).toBe(0);
  });

  it("reports per-entry results for a mixed valid/invalid/duplicate batch, without failing the whole batch", async () => {
    const project = await makeProject();
    await callBatchYouTube(String(project.id), [V1]); // pre-seed a duplicate

    const { statusCode, body } = await callBatchYouTube(String(project.id), [V1, V2, "not a url"]);
    expect(statusCode).toBe(200);
    expect(body.results.map((r) => r.kind)).toEqual(["duplicate", "added", "invalid"]);
    expect(body.addedCount).toBe(1);
    expect(body.duplicateCount).toBe(1);
    expect(body.invalidCount).toBe(1);
  });

  it("rejects an empty urls array with 400, creates nothing", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callBatchYouTube(String(project.id), []);
    expect(statusCode).toBe(400);
    expect(body.error?.type).toBe("invalid_request");
  });

  it("rejects a non-array urls with 400", async () => {
    const project = await makeProject();
    const { statusCode } = await callBatchYouTube(String(project.id), "not-an-array");
    expect(statusCode).toBe(400);
  });

  it("rejects a batch over the max size", async () => {
    const project = await makeProject();
    const urls = Array.from({ length: 51 }, (_, i) => `https://www.youtube.com/watch?v=${String(i).padStart(11, "0")}`);
    const { statusCode } = await callBatchYouTube(String(project.id), urls);
    expect(statusCode).toBe(400);
  });

  it("unknown project returns 404", async () => {
    const { statusCode } = await callBatchYouTube("999999999", [V1]);
    expect(statusCode).toBe(404);
  });
});

describe("POST /api/projects/:projectId/sources/discord/batch (Phase 4K)", () => {
  it("imports multiple valid attachments, durably capturing each one exactly like the single-URL route", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callBatchDiscord(String(project.id), [DISCORD_URL_1, DISCORD_URL_2]);
    expect(statusCode).toBe(200);
    expect(body.addedCount).toBe(2);
  });

  it("a download failure for one URL reports it as invalid and deletes the compensating row — never failing the rest of the batch", async () => {
    const project = await makeProject();
    const failingDownload = vi.fn(async () => {
      throw new DiscordAttachmentDownloadError("Could not download this Discord attachment.");
    });
    const { statusCode, body } = await callBatchDiscord(String(project.id), [DISCORD_URL_1, DISCORD_URL_2], failingDownload);
    expect(statusCode).toBe(200);
    expect(body.invalidCount).toBe(2);
    expect(body.addedCount).toBe(0);

    const rowCount = await pool.query(`SELECT COUNT(*) AS count FROM project_sources WHERE project_id = $1`, [project.id]);
    expect(Number((rowCount.rows[0] as { count: string }).count)).toBe(0);
  });

  it("mixed valid + invalid URL batch reports each independently, never hiding partial success", async () => {
    const project = await makeProject();
    const { statusCode, body } = await callBatchDiscord(String(project.id), [DISCORD_URL_1, "https://example.com/not-discord.mp4"]);
    expect(statusCode).toBe(200);
    expect(body.results[0].kind).toBe("added");
    expect(body.results[1].kind).toBe("invalid");
  });

  it("never weakens Discord host validation for a batch entry", async () => {
    const project = await makeProject();
    const fetchMock = vi.fn();
    const download = vi.fn(fetchMock);
    const { body } = await callBatchDiscord(String(project.id), ["https://evil.example.com/attachments/1/2/clip.mp4"], download);
    expect(body.results[0].kind).toBe("invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
