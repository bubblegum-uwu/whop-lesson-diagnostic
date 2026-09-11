import { describe, it, expect, afterAll } from "vitest";
import {
  createYouTubeSource,
  createDiscordSource,
  deleteProjectSource,
  getProjectSourceById,
  listProjectSourcesByProjectId,
  SUPPORTED_PROJECT_SOURCE_PROVIDERS,
} from "../src/db/projectSourcesRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(projectType: "TRADING_STRATEGIES" | "GENERAL_KNOWLEDGE" = "TRADING_STRATEGIES") {
  const name = randomId("proj");
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, project_type) VALUES ($1, $2) RETURNING id`,
    [name, projectType],
  );
  return { id: Number(result.rows[0].id), name };
}

describe("SUPPORTED_PROJECT_SOURCE_PROVIDERS", () => {
  it("allow-lists YOUTUBE and, as of Phase 4I, DISCORD (never WHOP — that path is courses.project_id, not a project_sources row)", () => {
    expect(Array.from(SUPPORTED_PROJECT_SOURCE_PROVIDERS).sort()).toEqual(["DISCORD", "YOUTUBE"]);
  });
});

describe("createYouTubeSource", () => {
  it("inserts a new project_sources row with status READY and no title/duration", async () => {
    const project = await makeProject();
    const { source, created } = await createYouTubeSource(pool, {
      projectId: project.id,
      externalId: "dQw4w9WgXcQ",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    expect(created).toBe(true);
    expect(source.projectId).toBe(project.id);
    expect(source.provider).toBe("YOUTUBE");
    expect(source.externalId).toBe("dQw4w9WgXcQ");
    expect(source.sourceUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(source.title).toBeNull();
    expect(source.durationSeconds).toBeNull();
    expect(source.status).toBe("READY");
    expect(source.errorMessage).toBeNull();
  });

  it("M: adding the same video twice to the same project is a deterministic duplicate (created: false, same row returned)", async () => {
    const project = await makeProject();
    const first = await createYouTubeSource(pool, {
      projectId: project.id,
      externalId: "dupVideo001",
      sourceUrl: "https://www.youtube.com/watch?v=dupVideo001",
    });
    const second = await createYouTubeSource(pool, {
      projectId: project.id,
      externalId: "dupVideo001",
      sourceUrl: "https://www.youtube.com/watch?v=dupVideo001",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);

    const rows = await listProjectSourcesByProjectId(pool, project.id);
    expect(rows.filter((r) => r.externalId === "dupVideo001")).toHaveLength(1);
  });

  it("N: the same video is allowed in two different projects", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();

    const inA = await createYouTubeSource(pool, {
      projectId: projectA.id,
      externalId: "sharedVid01",
      sourceUrl: "https://www.youtube.com/watch?v=sharedVid01",
    });
    const inB = await createYouTubeSource(pool, {
      projectId: projectB.id,
      externalId: "sharedVid01",
      sourceUrl: "https://www.youtube.com/watch?v=sharedVid01",
    });

    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);
    expect(inA.source.id).not.toBe(inB.source.id);
  });

  it("the UNIQUE constraint is the real race-safety guarantee, not application logic — concurrent inserts for the same video never both create a row", async () => {
    const project = await makeProject();
    const input = {
      projectId: project.id,
      externalId: "raceVideo01",
      sourceUrl: "https://www.youtube.com/watch?v=raceVideo01",
    };

    const [a, b, c] = await Promise.all([
      createYouTubeSource(pool, input),
      createYouTubeSource(pool, input),
      createYouTubeSource(pool, input),
    ]);

    const createdCount = [a, b, c].filter((r) => r.created).length;
    expect(createdCount).toBe(1);
    expect(new Set([a.source.id, b.source.id, c.source.id]).size).toBe(1);
  });
});

describe("listProjectSourcesByProjectId", () => {
  it("O: never returns another project's sources — strictly scoped by project_id", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await createYouTubeSource(pool, { projectId: projectA.id, externalId: "videoInA0001", sourceUrl: "https://www.youtube.com/watch?v=videoInA0001" });
    await createYouTubeSource(pool, { projectId: projectB.id, externalId: "videoInB0001", sourceUrl: "https://www.youtube.com/watch?v=videoInB0001" });

    const sourcesA = await listProjectSourcesByProjectId(pool, projectA.id);
    const sourcesB = await listProjectSourcesByProjectId(pool, projectB.id);

    expect(sourcesA.map((s) => s.externalId)).toEqual(["videoInA0001"]);
    expect(sourcesB.map((s) => s.externalId)).toEqual(["videoInB0001"]);
  });

  it("returns an empty array for a project with no sources", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    expect(await listProjectSourcesByProjectId(pool, project.id)).toEqual([]);
  });

  it("R: a GENERAL_KNOWLEDGE project can store a YouTube source just like a TRADING_STRATEGIES one", async () => {
    const project = await makeProject("GENERAL_KNOWLEDGE");
    const { created } = await createYouTubeSource(pool, {
      projectId: project.id,
      externalId: "gkVideo00001",
      sourceUrl: "https://www.youtube.com/watch?v=gkVideo00001",
    });
    expect(created).toBe(true);
    const sources = await listProjectSourcesByProjectId(pool, project.id);
    expect(sources).toHaveLength(1);
  });
});

const DISCORD_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

describe("createDiscordSource (Phase 4I)", () => {
  it("inserts a new project_sources row with provider DISCORD, status READY, and no title/duration", async () => {
    const project = await makeProject();
    const { source, created } = await createDiscordSource(pool, {
      projectId: project.id,
      externalId: "987654321098765432",
      sourceUrl: DISCORD_URL,
    });

    expect(created).toBe(true);
    expect(source.projectId).toBe(project.id);
    expect(source.provider).toBe("DISCORD");
    expect(source.externalId).toBe("987654321098765432");
    expect(source.sourceUrl).toBe(DISCORD_URL);
    expect(source.title).toBeNull();
    expect(source.durationSeconds).toBeNull();
    expect(source.status).toBe("READY");
  });

  it("adding the same Discord attachment twice to the same project is a deterministic duplicate (created: false, same row)", async () => {
    const project = await makeProject();
    const first = await createDiscordSource(pool, { projectId: project.id, externalId: "dupAttach001", sourceUrl: DISCORD_URL });
    const second = await createDiscordSource(pool, { projectId: project.id, externalId: "dupAttach001", sourceUrl: DISCORD_URL });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
  });

  it("the same Discord attachment id is allowed in two different projects (identity is scoped per-project, same as YouTube)", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const inA = await createDiscordSource(pool, { projectId: projectA.id, externalId: "sharedAttach1", sourceUrl: DISCORD_URL });
    const inB = await createDiscordSource(pool, { projectId: projectB.id, externalId: "sharedAttach1", sourceUrl: DISCORD_URL });

    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);
    expect(inA.source.id).not.toBe(inB.source.id);
  });

  it("YouTube and Discord sources with the same external_id string never collide — provider is part of the identity", async () => {
    const project = await makeProject();
    const yt = await createYouTubeSource(pool, { projectId: project.id, externalId: "sameIdString", sourceUrl: "https://www.youtube.com/watch?v=sameIdString" });
    const disc = await createDiscordSource(pool, { projectId: project.id, externalId: "sameIdString", sourceUrl: DISCORD_URL });

    expect(yt.created).toBe(true);
    expect(disc.created).toBe(true);
    expect(yt.source.id).not.toBe(disc.source.id);

    const sources = await listProjectSourcesByProjectId(pool, project.id);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.provider).sort()).toEqual(["DISCORD", "YOUTUBE"]);
  });
});

describe("deleteProjectSource (Phase 4I durability fix — compensating cleanup)", () => {
  it("removes the source so it never appears again", async () => {
    const project = await makeProject();
    const { source } = await createDiscordSource(pool, { projectId: project.id, externalId: "toDelete1", sourceUrl: DISCORD_URL });

    await deleteProjectSource(pool, source.id);

    expect(await getProjectSourceById(pool, source.id)).toBeNull();
    expect(await listProjectSourcesByProjectId(pool, project.id)).toEqual([]);
  });

  it("deleting one project's source never affects another project's sources", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const { source: sourceA } = await createDiscordSource(pool, { projectId: projectA.id, externalId: "toDelete2", sourceUrl: DISCORD_URL });
    await createDiscordSource(pool, { projectId: projectB.id, externalId: "keepThis1", sourceUrl: DISCORD_URL });

    await deleteProjectSource(pool, sourceA.id);

    expect(await listProjectSourcesByProjectId(pool, projectA.id)).toEqual([]);
    expect(await listProjectSourcesByProjectId(pool, projectB.id)).toHaveLength(1);
  });
});
