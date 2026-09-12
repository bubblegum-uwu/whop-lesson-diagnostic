import { describe, it, expect, afterAll, vi } from "vitest";
import type { Request } from "express";
import { createAddDiscordSourceHandler } from "../src/http/routes/projectSources.js";
import { listProjectSourcesByProjectId } from "../src/db/projectSourcesRepo.js";
import { getContentAssetMedia, upsertContentAsset } from "../src/db/contentAssetsRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { createDiscordCaptureJob, getDiscordCaptureJobById } from "../src/db/discordCaptureJobsRepo.js";
import { runDiscordCaptureLoop } from "../src/worker/discordCaptureLoop.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";
import { makeResponse } from "./helpers/httpMocks.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'GENERAL_KNOWLEDGE') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

function fakeDownload(overrides: Partial<{ content: Buffer; contentType: string; byteSize: number }> = {}) {
  return vi.fn(async () => ({
    content: Buffer.from("fake-video-bytes"),
    contentType: "video/mp4",
    byteSize: 16,
    ...overrides,
  }));
}

describe("Discord shared content-asset — owner-scoped uniqueness (no cross-user leakage)", () => {
  it("the SAME attachment id under TWO DIFFERENT owner identities creates two independent content_assets — never shared cross-user", async () => {
    const attachmentId = randomSnowflake();
    const identityA = randomId("identity-a");
    const identityB = randomId("identity-b");

    const { asset: assetA, created: createdA } = await upsertContentAsset(pool, { ownerIdentity: identityA, provider: "DISCORD", externalId: attachmentId });
    const { asset: assetB, created: createdB } = await upsertContentAsset(pool, { ownerIdentity: identityB, provider: "DISCORD", externalId: attachmentId });

    expect(createdA).toBe(true);
    expect(createdB).toBe(true);
    expect(assetA.id).not.toBe(assetB.id);

    // Re-upserting under identity A again must reuse A's asset, never B's.
    const { asset: assetAAgain, created: createdAAgain } = await upsertContentAsset(pool, { ownerIdentity: identityA, provider: "DISCORD", externalId: attachmentId });
    expect(createdAAgain).toBe(false);
    expect(assetAAgain.id).toBe(assetA.id);
  });
});

describe("Discord shared content-asset — dedup across the URL-import and Save-to-Knovera capture paths", () => {
  it("URL import first, then a later Save-to-Knovera capture of the SAME attachment, converge on one asset with no re-download", async () => {
    const identity = randomId("identity");
    const urlImportProject = await makeProject();
    const discordKnowledgeProject = await makeProject();
    const attachmentId = randomSnowflake();
    const attachmentUrl = `https://cdn.discordapp.com/attachments/1/${attachmentId}/clip.mp4?ex=1&is=2&hm=3`;

    const urlDownload = fakeDownload({ content: Buffer.from("original-bytes") });
    const importHandler = createAddDiscordSourceHandler({ pool, downloadDiscordAttachment: urlDownload });
    const { res, statusCode } = makeResponse();
    await importHandler({ params: { projectId: String(urlImportProject.id) }, body: { url: attachmentUrl }, knoveraOperator: identity } as unknown as Request, res);
    expect(statusCode()).toBe(201);
    expect(urlDownload).toHaveBeenCalledTimes(1);

    const { collection } = await createSourceCollection(pool, {
      projectId: discordKnowledgeProject.id,
      provider: "DISCORD",
      externalId: randomId("channel"),
      title: "#clips",
      sourceUrl: "https://discord.com/channels/g/c",
    });
    const { job } = await createDiscordCaptureJob(pool, {
      ownerIdentity: identity,
      discordUserId: randomSnowflake(),
      projectId: discordKnowledgeProject.id,
      collectionId: collection.id,
      interactionId: randomId("interaction"),
      messageId: randomId("msg"),
      channelId: randomId("chan"),
      guildId: "guild_1",
      channelLabel: "#clips",
      attachmentId,
      attachmentUrl,
      filename: "clip.mp4",
      contentType: "video/mp4",
      byteSize: 1024,
    });

    const captureDownload = fakeDownload({ content: Buffer.from("SHOULD-NEVER-BE-WRITTEN") });
    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: captureDownload });

    expect(captureDownload).not.toHaveBeenCalled(); // the asset already existed — never re-downloaded

    const finishedJob = await getDiscordCaptureJobById(pool, job.id);
    expect(finishedJob?.status).toBe("COMPLETED");

    const urlImportSources = await listProjectSourcesByProjectId(pool, urlImportProject.id);
    const discordKnowledgeSources = await listProjectSourcesByProjectId(pool, discordKnowledgeProject.id);
    expect(urlImportSources).toHaveLength(1);
    expect(discordKnowledgeSources).toHaveLength(1);
    expect(discordKnowledgeSources[0].contentAssetId).toBe(urlImportSources[0].contentAssetId);

    const media = await getContentAssetMedia(pool, urlImportSources[0].contentAssetId!);
    expect(media?.content.toString()).toBe("original-bytes"); // the FIRST capture's bytes — never overwritten by a later duplicate
  });

  it("a Save-to-Knovera capture first, then a later URL import of the SAME attachment, converge on one asset with no re-download", async () => {
    const identity = randomId("identity");
    const discordKnowledgeProject = await makeProject();
    const urlImportProject = await makeProject();
    const attachmentId = randomSnowflake();
    const attachmentUrl = `https://cdn.discordapp.com/attachments/1/${attachmentId}/clip.mp4?ex=1&is=2&hm=3`;

    const { collection } = await createSourceCollection(pool, {
      projectId: discordKnowledgeProject.id,
      provider: "DISCORD",
      externalId: randomId("channel"),
      title: "#clips",
      sourceUrl: "https://discord.com/channels/g/c",
    });
    await createDiscordCaptureJob(pool, {
      ownerIdentity: identity,
      discordUserId: randomSnowflake(),
      projectId: discordKnowledgeProject.id,
      collectionId: collection.id,
      interactionId: randomId("interaction"),
      messageId: randomId("msg"),
      channelId: randomId("chan"),
      guildId: "guild_1",
      channelLabel: "#clips",
      attachmentId,
      attachmentUrl,
      filename: "clip.mp4",
      contentType: "video/mp4",
      byteSize: 1024,
    });
    const captureDownload = fakeDownload({ content: Buffer.from("captured-bytes") });
    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: captureDownload });
    expect(captureDownload).toHaveBeenCalledTimes(1);

    const urlDownload = fakeDownload({ content: Buffer.from("SHOULD-NEVER-BE-WRITTEN") });
    const importHandler = createAddDiscordSourceHandler({ pool, downloadDiscordAttachment: urlDownload });
    const { res, statusCode, body } = makeResponse();
    await importHandler({ params: { projectId: String(urlImportProject.id) }, body: { url: attachmentUrl }, knoveraOperator: identity } as unknown as Request, res);

    expect(statusCode()).toBe(201);
    expect(urlDownload).not.toHaveBeenCalled(); // the asset already existed from the capture — never re-downloaded

    const createdSourceId = (body() as { source: { id: number } }).source.id;
    const urlImportSources = await listProjectSourcesByProjectId(pool, urlImportProject.id);
    expect(urlImportSources[0].id).toBe(createdSourceId);

    const media = await getContentAssetMedia(pool, urlImportSources[0].contentAssetId!);
    expect(media?.content.toString()).toBe("captured-bytes"); // the FIRST (capture) path's bytes — never overwritten
  });
});
