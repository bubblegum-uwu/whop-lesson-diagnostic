import { describe, it, expect, afterAll } from "vitest";
import { createSynthesisSet, listSynthesisSetsByProjectId, getSynthesisSetById, updateSynthesisSet, deleteSynthesisSet } from "../src/db/synthesisSetsRepo.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

describe("synthesisSetsRepo", () => {
  it("creates a synthesis set with name/description and default timestamps", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "Scalping Playbook", description: "My scalping sources" });

    expect(set.projectId).toBe(project.id);
    expect(set.name).toBe("Scalping Playbook");
    expect(set.description).toBe("My scalping sources");
    expect(set.createdAt).toBeInstanceOf(Date);
  });

  it("supports a null description", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "No description", description: null });
    expect(set.description).toBeNull();
  });

  it("lists every synthesis set for a project, ordered by creation", async () => {
    const project = await makeProject();
    const a = await createSynthesisSet(pool, { projectId: project.id, name: "A", description: null });
    const b = await createSynthesisSet(pool, { projectId: project.id, name: "B", description: null });

    const sets = await listSynthesisSetsByProjectId(pool, project.id);
    expect(sets.map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("project isolation: a project's sets are never returned for another project", async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    await createSynthesisSet(pool, { projectId: projectA.id, name: "A-set", description: null });
    await createSynthesisSet(pool, { projectId: projectB.id, name: "B-set", description: null });

    const setsA = await listSynthesisSetsByProjectId(pool, projectA.id);
    const setsB = await listSynthesisSetsByProjectId(pool, projectB.id);
    expect(setsA.map((s) => s.name)).toEqual(["A-set"]);
    expect(setsB.map((s) => s.name)).toEqual(["B-set"]);
  });

  it("returns an empty array for a project with no sets", async () => {
    const project = await makeProject();
    expect(await listSynthesisSetsByProjectId(pool, project.id)).toEqual([]);
  });

  it("fetches a set by id", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "Fetch me", description: null });
    const fetched = await getSynthesisSetById(pool, set.id);
    expect(fetched?.name).toBe("Fetch me");
  });

  it("returns null for an unknown set id", async () => {
    expect(await getSynthesisSetById(pool, 999999999)).toBeNull();
  });

  it("updates the name only, leaving description untouched", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "Old Name", description: "Keep me" });
    const updated = await updateSynthesisSet(pool, set.id, { name: "New Name" });
    expect(updated?.name).toBe("New Name");
    expect(updated?.description).toBe("Keep me");
  });

  it("updates the description only, leaving name untouched", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "Keep me", description: "Old desc" });
    const updated = await updateSynthesisSet(pool, set.id, { description: "New desc" });
    expect(updated?.name).toBe("Keep me");
    expect(updated?.description).toBe("New desc");
  });

  it("can clear the description back to null", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "x", description: "has one" });
    const updated = await updateSynthesisSet(pool, set.id, { description: null });
    expect(updated?.description).toBeNull();
  });

  it("bumps updated_at on update", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "x", description: null });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await updateSynthesisSet(pool, set.id, { name: "y" });
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(set.updatedAt.getTime());
  });

  it("deletes a synthesis set", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "delete me", description: null });
    await deleteSynthesisSet(pool, set.id);
    expect(await getSynthesisSetById(pool, set.id)).toBeNull();
  });

  it("deleting a project cascades to its synthesis sets", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "cascade me", description: null });
    await pool.query(`DELETE FROM projects WHERE id = $1`, [project.id]);
    expect(await getSynthesisSetById(pool, set.id)).toBeNull();
  });
});
