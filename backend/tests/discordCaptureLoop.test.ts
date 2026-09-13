import { describe, it, expect, afterAll, vi } from "vitest";
import { runDiscordCaptureLoop } from "../src/worker/discordCaptureLoop.js";
import { createDiscordCaptureJob, getDiscordCaptureJobById } from "../src/db/discordCaptureJobsRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { getProjectSourceById, listProjectSourcesByProjectId } from "../src/db/projectSourcesRepo.js";
import { getContentAssetMedia } from "../src/db/contentAssetsRepo.js";
import { DiscordAttachmentDownloadError } from "../src/discord/downloadDiscordAttachment.js";
import { createTestPool, randomId, randomSnowflake } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'GENERAL_KNOWLEDGE') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeCollection(projectId: number): Promise<{ id: number }> {
  const { collection } = await createSourceCollection(pool, {
    projectId,
    provider: "DISCORD",
    externalId: randomId("channel"),
    title: "#trading-videos",
    sourceUrl: "https://discord.com/channels/guild/chan",
  });
  return { id: collection.id };
}

function fakeDownload(overrides: Partial<{ content: Buffer; contentType: string; byteSize: number }> = {}) {
  return vi.fn(async () => ({
    content: Buffer.from("fake-video-bytes"),
    contentType: "video/mp4",
    byteSize: 16,
    ...overrides,
  }));
}

interface JobInputOverrides {
  ownerIdentity?: string;
  projectId: number;
  collectionId: number | null;
  interactionId?: string;
  attachmentId?: string;
  attachmentUrl?: string;
  filename?: string;
}

async function enqueueJob(input: JobInputOverrides) {
  return createDiscordCaptureJob(pool, {
    ownerIdentity: input.ownerIdentity ?? randomId("identity"),
    discordUserId: randomSnowflake(),
    projectId: input.projectId,
    collectionId: input.collectionId as number,
    interactionId: input.interactionId ?? randomId("interaction"),
    messageId: randomId("msg"),
    channelId: randomId("chan"),
    guildId: "guild_1",
    channelLabel: "#trading-videos",
    attachmentId: input.attachmentId ?? randomSnowflake(),
    attachmentUrl: input.attachmentUrl ?? "https://cdn.discordapp.com/attachments/1/2/clip.mp4",
    filename: input.filename ?? "clip.mp4",
    contentType: "video/mp4",
    byteSize: 1024,
  });
}

describe("runDiscordCaptureLoop", () => {
  it("A: a successful download completes the job, creates a READY project_source, and durably saves the media", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const ownerIdentity = randomId("identity");
    const { job } = await enqueueJob({ ownerIdentity, projectId: project.id, collectionId: collection.id });
    const download = fakeDownload({ content: Buffer.from("real-bytes"), contentType: "video/mp4", byteSize: 10 });

    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: download });

    expect(download).toHaveBeenCalledWith(job.attachmentUrl);
    const finished = await getDiscordCaptureJobById(pool, job.id);
    expect(finished?.status).toBe("COMPLETED");
    expect(finished?.projectSourceId).not.toBeNull();

    const source = await getProjectSourceById(pool, finished!.projectSourceId!);
    expect(source?.status).toBe("READY");
    expect(source?.provider).toBe("DISCORD");
    expect(source?.externalId).toBe(job.attachmentId);
    expect(source?.collectionId).toBe(collection.id);

    const media = await getContentAssetMedia(pool, source!.contentAssetId!);
    expect(media?.content.toString()).toBe("real-bytes");
  });

  it("B: a download failure marks the job FAILED and leaves no dangling project_source or content_asset behind", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const { job } = await enqueueJob({ projectId: project.id, collectionId: collection.id });
    const failingDownload = vi.fn(async () => {
      throw new DiscordAttachmentDownloadError("Could not download this Discord attachment (HTTP 403) — the link may already be invalid or expired.");
    });

    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: failingDownload });

    const finished = await getDiscordCaptureJobById(pool, job.id);
    expect(finished?.status).toBe("FAILED");
    expect(finished?.projectSourceId).toBeNull();
    expect(finished?.sanitizedError).toContain("Could not download");

    const sources = await listProjectSourcesByProjectId(pool, project.id);
    expect(sources).toHaveLength(0);
  });

  it("C: capturing the same attachment a second time (a new interaction, e.g. a repeat 'Save to Knovera' invocation) never re-downloads or duplicates media", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const ownerIdentity = randomId("identity");
    const attachmentId = randomSnowflake();
    const attachmentUrl = "https://cdn.discordapp.com/attachments/1/shared/clip.mp4";

    const { job: firstJob } = await enqueueJob({ ownerIdentity, projectId: project.id, collectionId: collection.id, attachmentId, attachmentUrl });
    const download = fakeDownload();
    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: download });
    expect(download).toHaveBeenCalledTimes(1);

    const { job: secondJob } = await enqueueJob({ ownerIdentity, projectId: project.id, collectionId: collection.id, attachmentId, attachmentUrl });
    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: download });

    expect(download).toHaveBeenCalledTimes(1); // never called again — the asset already existed

    const firstFinished = await getDiscordCaptureJobById(pool, firstJob.id);
    const secondFinished = await getDiscordCaptureJobById(pool, secondJob.id);
    expect(firstFinished?.status).toBe("COMPLETED");
    expect(secondFinished?.status).toBe("COMPLETED");
    expect(secondFinished?.projectSourceId).toBe(firstFinished?.projectSourceId);

    const sources = await listProjectSourcesByProjectId(pool, project.id);
    expect(sources).toHaveLength(1);
  });

  it("D: drains multiple queued jobs in one call", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    const { job: jobA } = await enqueueJob({ projectId: project.id, collectionId: collection.id });
    const { job: jobB } = await enqueueJob({ projectId: project.id, collectionId: collection.id });

    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: fakeDownload() });

    expect((await getDiscordCaptureJobById(pool, jobA.id))?.status).toBe("COMPLETED");
    expect((await getDiscordCaptureJobById(pool, jobB.id))?.status).toBe("COMPLETED");
  });

  it("E: never calls Gemini or creates a project-source analysis job — capture is strictly separate from analysis", async () => {
    const project = await makeProject();
    const collection = await makeCollection(project.id);
    await enqueueJob({ projectId: project.id, collectionId: collection.id });

    await runDiscordCaptureLoop({ pool, downloadDiscordAttachment: fakeDownload() });

    // Scoped to this test's own project (never a bare table-wide count) —
    // the shared test database is not truncated between test files, so
    // other suites' analysis jobs for unrelated projects legitimately exist.
    const analysisJobs = await pool.query(
      `SELECT COUNT(*)::int AS count FROM project_source_analysis_jobs j
       JOIN project_sources s ON s.id = j.project_source_id
       WHERE s.project_id = $1`,
      [project.id],
    );
    expect(analysisJobs.rows[0].count).toBe(0);
  });
});
