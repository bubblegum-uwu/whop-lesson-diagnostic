import { describe, it, expect, afterAll } from "vitest";
import {
  createSourceCollection,
  getSourceCollectionById,
  listSourceCollectionsByProjectId,
  markCollectionSynced,
  markCollectionSyncFailed,
  deleteSourceCollection,
} from "../src/db/sourceCollectionsRepo.js";
import { createYouTubeSource, getProjectSourceById } from "../src/db/projectSourcesRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

describe("sourceCollectionsRepo", () => {
  it("creates a YouTube collection", async () => {
    const project = await makeProject();
    const { collection, created } = await createSourceCollection(pool, {
      projectId: project.id,
      provider: "YOUTUBE",
      externalId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      title: "SMB Capital",
      sourceUrl: "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw",
    });
    expect(created).toBe(true);
    expect(collection.status).toBe("READY");
    expect(collection.projectId).toBe(project.id);
  });

  it("project isolation: a project's collections are never returned for another project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await createSourceCollection(pool, { projectId: projectA.id, provider: "YOUTUBE", externalId: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "A", sourceUrl: "https://x" });
    await createSourceCollection(pool, { projectId: projectB.id, provider: "YOUTUBE", externalId: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "B", sourceUrl: "https://x" });

    const collectionsA = await listSourceCollectionsByProjectId(pool, projectA.id);
    const collectionsB = await listSourceCollectionsByProjectId(pool, projectB.id);
    expect(collectionsA.map((c) => c.title)).toEqual(["A"]);
    expect(collectionsB.map((c) => c.title)).toEqual(["B"]);
  });

  it("provider identity uniqueness is project-scoped: the SAME channel ID can be added to two different projects", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const externalId = "UCsharedsharedsharedshar";
    const a = await createSourceCollection(pool, { projectId: projectA.id, provider: "YOUTUBE", externalId, title: "Shared", sourceUrl: "https://x" });
    const b = await createSourceCollection(pool, { projectId: projectB.id, provider: "YOUTUBE", externalId, title: "Shared", sourceUrl: "https://x" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.collection.id).not.toBe(b.collection.id);
  });

  it("adding the same channel to the same project twice is idempotent — returns the existing collection, never a duplicate", async () => {
    const project = await makeProject();
    const first = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCidempotentidempotentid", title: "X", sourceUrl: "https://x" });
    const second = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCidempotentidempotentid", title: "X", sourceUrl: "https://x" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.collection.id).toBe(first.collection.id);

    const all = await listSourceCollectionsByProjectId(pool, project.id);
    expect(all).toHaveLength(1);
  });

  it("fetches a collection by id", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCfetchmefetchmefetchme", title: "Fetch Me", sourceUrl: "https://x" });
    const fetched = await getSourceCollectionById(pool, collection.id);
    expect(fetched?.title).toBe("Fetch Me");
  });

  it("markCollectionSynced updates title and last_synced_at, clears any prior error", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCrenamerenamerenamerena", title: "Old Name", sourceUrl: "https://x" });
    await markCollectionSyncFailed(pool, collection.id, "Something went wrong.");
    await markCollectionSynced(pool, collection.id, "New Name");

    const refreshed = await getSourceCollectionById(pool, collection.id);
    expect(refreshed?.title).toBe("New Name");
    expect(refreshed?.status).toBe("READY");
    expect(refreshed?.sanitizedError).toBeNull();
    expect(refreshed?.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("markCollectionSyncFailed sets SYNC_FAILED with a sanitized error, never touches membership", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCfailfailfailfailfailfa", title: "X", sourceUrl: "https://x" });
    const { source } = await createYouTubeSource(pool, { projectId: project.id, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=x", collectionId: collection.id });

    await markCollectionSyncFailed(pool, collection.id, "Feed unreachable.");

    const refreshed = await getSourceCollectionById(pool, collection.id);
    expect(refreshed?.status).toBe("SYNC_FAILED");
    expect(refreshed?.sanitizedError).toBe("Feed unreachable.");
    const sourceStillLinked = await getProjectSourceById(pool, source.id);
    expect(sourceStillLinked?.collectionId).toBe(collection.id);
  });

  it("deleting a collection removes the collection but preserves its member sources — collection_id set to null (project_sources_collection_project_fkey ON DELETE SET NULL)", async () => {
    const project = await makeProject();
    const { collection } = await createSourceCollection(pool, { projectId: project.id, provider: "YOUTUBE", externalId: "UCdeleteme000000000000deletm", title: "X", sourceUrl: "https://x" });
    const { source } = await createYouTubeSource(pool, { projectId: project.id, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=y", collectionId: collection.id });

    await deleteSourceCollection(pool, collection.id);

    expect(await getSourceCollectionById(pool, collection.id)).toBeNull();
    const sourceAfter = await getProjectSourceById(pool, source.id);
    expect(sourceAfter).not.toBeNull();
    expect(sourceAfter?.collectionId).toBeNull();
  });

  it("cross-project item association is rejected by the database itself: a direct SQL insert linking a source to another project's collection fails", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const { collection: collectionA } = await createSourceCollection(pool, { projectId: projectA.id, provider: "YOUTUBE", externalId: "UCcrossprojectcrossproje", title: "A", sourceUrl: "https://x" });
    const { source: sourceB } = await createYouTubeSource(pool, { projectId: projectB.id, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=z" });

    await expect(pool.query(`UPDATE project_sources SET collection_id = $1 WHERE id = $2`, [collectionA.id, sourceB.id])).rejects.toThrow(/foreign key constraint/i);
  });
});
