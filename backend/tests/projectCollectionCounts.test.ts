import { describe, it, expect, afterAll } from "vitest";
import type { Request } from "express";
import { createListProjectsHandler, createGetProjectHandler, createCreateProjectHandler } from "../src/http/routes/projects.js";
import { getCollectionCountForProject, getCollectionCountsForProjects } from "../src/db/projectsRepo.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { createSourceCollection } from "../src/db/sourceCollectionsRepo.js";
import { insertManualOrigin, insertDiscordChannelOrigin } from "../src/db/projectSourceOriginsRepo.js";
import { createWhopLessonImport } from "../src/db/whopLessonImportsRepo.js";
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

function newVideoExternalId(): string {
  return randomId("vid").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 11).padEnd(11, "0");
}

async function makeYouTubeSourceViaDiscordChannel(projectId: number, guildId: string, channelId: string) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: newVideoExternalId(), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await insertDiscordChannelOrigin(pool, { projectSourceId: source.id, guildId, channelId, channelName: null, messageId: randomId("msg"), messageUrl: null, postedAt: new Date() });
  return source;
}

async function makeManualYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: newVideoExternalId(), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  await insertManualOrigin(pool, source.id);
  return source;
}

async function makeChannelLessDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, { ownerIdentity: "test-identity", projectId, externalId: randomId("attach"), sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3" });
  return source;
}

async function makeCourse(projectId: number | null): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO courses (whop_course_id, whop_experience_id, slug, title, project_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [randomId("course"), randomId("exp"), randomId("slug"), "Test Course", projectId],
  );
  return { id: Number(result.rows[0].id) };
}

async function makeLesson(courseId: number): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO lessons (course_id, whop_lesson_id, title, lesson_type, source_url) VALUES ($1, $2, $3, 'video', $4) RETURNING id`,
    [courseId, randomId("lesson"), "Lesson", "https://whop.com/lessons/1"],
  );
  return { id: Number(result.rows[0].id) };
}

function callList() {
  const handler = createListProjectsHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({} as Request, res).then(() => ({ statusCode: statusCode(), body: body() as { projects: Array<{ id: number; collectionCount: number }> } }));
}

function callGet(projectId: string) {
  const handler = createGetProjectHandler({ pool });
  const { res, statusCode, body } = makeResponse();
  return handler({ params: { projectId } } as unknown as Request, res).then(() => ({ statusCode: statusCode(), body: body() as { project: { collectionCount: number } } }));
}

describe("Project cards — canonical collectionCount (Phase 4L follow-up)", () => {
  it("1: a project with 2 collection groups and 4 project_sources reports collectionCount 2, never the raw source count", async () => {
    const project = await makeProject();
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c1");
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c1");
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c2");
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c2");
    // 4 sources, but only 2 distinct Discord-channel derived groups.
    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(2);
  });

  it("2: derived groups (YouTube-via-Discord-channel, YouTube à-la-carte, Unclassified) each count as one collection", async () => {
    const project = await makeProject();
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c1"); // youtube-discord-channel group
    await makeManualYouTubeSource(project.id); // youtube-ala-carte group
    await makeChannelLessDiscordSource(project.id); // unclassified group
    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(3);
  });

  it("3: persisted collections (YouTube channel, Discord channel) each count as one collection", async () => {
    const project = await makeProject();
    await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCabc", title: "TraderTV", sourceUrl: "https://www.youtube.com/channel/UCabc" });
    await createSourceCollection(pool, { projectId: project.id, provider: "DISCORD", externalId: "g1:c1", title: "#pre-market-live", sourceUrl: "https://discord.com/channels/g1/c1" });
    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(2);
  });

  it("4: Whop courses each count as one collection", async () => {
    const project = await makeProject();
    await makeCourse(project.id);
    await makeCourse(project.id);
    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(2);
  });

  it("5: the Whop à-la-carte group counts as exactly ONE collection regardless of how many lessons it holds, and only when non-empty", async () => {
    const project = await makeProject();
    const courseA = await makeCourse(null);
    const lessonA = await makeLesson(courseA.id);
    const lessonB = await makeLesson(courseA.id);
    await createWhopLessonImport(pool, project.id, lessonA.id);
    await createWhopLessonImport(pool, project.id, lessonB.id);
    // 2 à-la-carte lessons, but exactly 1 WHOP · À-LA-CARTE card.
    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(1);

    const emptyProject = await makeProject();
    expect(await getCollectionCountForProject(pool, emptyProject.id)).toBe(0);
  });

  it("6: an Unclassified group (genuinely channel-less Discord source) counts as one collection when present, zero when absent", async () => {
    const project = await makeProject();
    expect(await getCollectionCountForProject(pool, project.id)).toBe(0);
    await makeChannelLessDiscordSource(project.id);
    expect(await getCollectionCountForProject(pool, project.id)).toBe(1);
  });

  it("7: the full mix — persisted + derived + Whop course + Whop à-la-carte all fold into one total, matching exactly what Sources page would render", async () => {
    const project = await makeProject();
    await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCabc", title: "TraderTV", sourceUrl: "https://www.youtube.com/channel/UCabc" }); // +1 persisted
    await makeYouTubeSourceViaDiscordChannel(project.id, "g1", "c1"); // +1 derived
    await makeCourse(project.id); // +1 Whop course
    const alaCarteCourse = await makeCourse(null);
    const alaCarteLesson = await makeLesson(alaCarteCourse.id);
    await createWhopLessonImport(pool, project.id, alaCarteLesson.id); // +1 Whop à-la-carte (once)

    const count = await getCollectionCountForProject(pool, project.id);
    expect(count).toBe(4);
  });

  it("8: singular/plural — GET /api/projects and GET /api/projects/:id report the same collectionCount for the same project, batched vs. single-project paths agree", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await makeYouTubeSourceViaDiscordChannel(projectA.id, "g1", "c1");
    await makeManualYouTubeSource(projectB.id);
    await makeManualYouTubeSource(projectB.id); // same group — still 1 collection

    const [singleA, singleB] = await Promise.all([getCollectionCountForProject(pool, projectA.id), getCollectionCountForProject(pool, projectB.id)]);
    const batched = await getCollectionCountsForProjects(pool, [projectA.id, projectB.id]);
    expect(batched.get(projectA.id)).toBe(singleA);
    expect(batched.get(projectB.id)).toBe(singleB);
    expect(singleA).toBe(1);
    expect(singleB).toBe(1);

    const { body: listBody } = await callList();
    const rowA = listBody.projects.find((p) => p.id === projectA.id);
    const rowB = listBody.projects.find((p) => p.id === projectB.id);
    expect(rowA?.collectionCount).toBe(1);
    expect(rowB?.collectionCount).toBe(1);

    const { body: getBodyA } = await callGet(String(projectA.id));
    expect(getBodyA.project.collectionCount).toBe(1);
  });

  it("a freshly created project reports collectionCount 0, computed the same way as GET, never hand-zeroed", async () => {
    const handler = createCreateProjectHandler({ pool });
    const { res, statusCode, body } = makeResponse();
    await handler({ body: { name: randomId("fresh"), projectType: "TRADING_STRATEGIES" } } as unknown as Request, res);
    expect(statusCode()).toBe(201);
    expect((body() as { project: { collectionCount: number } }).project.collectionCount).toBe(0);
  });
});
