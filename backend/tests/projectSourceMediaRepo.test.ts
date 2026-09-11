import { describe, it, expect, afterAll } from "vitest";
import { createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { saveProjectSourceMedia, getProjectSourceMedia, deleteProjectSourceMedia } from "../src/db/projectSourceMediaRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [name]);
  return { id: Number(result.rows[0].id) };
}

async function makeDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, {
    projectId,
    externalId: randomId("attach"),
    sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3",
  });
  return source;
}

describe("projectSourceMediaRepo", () => {
  it("saves and retrieves persisted video bytes for a project source", async () => {
    const project = await makeProject();
    const source = await makeDiscordSource(project.id);

    await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: Buffer.from("hello video"), contentType: "video/mp4", byteSize: 11 });

    const media = await getProjectSourceMedia(pool, source.id);
    expect(media?.content.toString()).toBe("hello video");
    expect(media?.contentType).toBe("video/mp4");
    expect(media?.byteSize).toBe(11);
  });

  it("returns null for a project source with no persisted media", async () => {
    const project = await makeProject();
    const source = await makeDiscordSource(project.id);
    expect(await getProjectSourceMedia(pool, source.id)).toBeNull();
  });

  it("ON CONFLICT overwrites rather than erroring on a second save for the same project source", async () => {
    const project = await makeProject();
    const source = await makeDiscordSource(project.id);

    await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: Buffer.from("first"), contentType: "video/mp4", byteSize: 5 });
    await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: Buffer.from("second-version"), contentType: "video/quicktime", byteSize: 14 });

    const media = await getProjectSourceMedia(pool, source.id);
    expect(media?.content.toString()).toBe("second-version");
    expect(media?.contentType).toBe("video/quicktime");
  });

  it("deleting a project_sources row cascades to remove its media row", async () => {
    const project = await makeProject();
    const source = await makeDiscordSource(project.id);
    await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: Buffer.from("bytes"), contentType: "video/mp4", byteSize: 5 });

    await pool.query(`DELETE FROM project_sources WHERE id = $1`, [source.id]);
    expect(await getProjectSourceMedia(pool, source.id)).toBeNull();
  });

  it("deleteProjectSourceMedia removes the row directly (the compensating-cleanup path)", async () => {
    const project = await makeProject();
    const source = await makeDiscordSource(project.id);
    await saveProjectSourceMedia(pool, { projectSourceId: source.id, content: Buffer.from("bytes"), contentType: "video/mp4", byteSize: 5 });

    await deleteProjectSourceMedia(pool, source.id);
    expect(await getProjectSourceMedia(pool, source.id)).toBeNull();
  });

  it("media for one project source is never returned for another", async () => {
    const project = await makeProject();
    const sourceA = await makeDiscordSource(project.id);
    const sourceB = await makeDiscordSource(project.id);
    await saveProjectSourceMedia(pool, { projectSourceId: sourceA.id, content: Buffer.from("a-bytes"), contentType: "video/mp4", byteSize: 7 });

    expect((await getProjectSourceMedia(pool, sourceA.id))?.content.toString()).toBe("a-bytes");
    expect(await getProjectSourceMedia(pool, sourceB.id)).toBeNull();
  });
});
