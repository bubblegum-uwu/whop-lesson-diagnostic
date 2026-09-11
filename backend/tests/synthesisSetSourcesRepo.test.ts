import { describe, it, expect, afterAll } from "vitest";
import { createSynthesisSet } from "../src/db/synthesisSetsRepo.js";
import {
  addSourceToSynthesisSet,
  removeSourceFromSynthesisSet,
  listProjectSourceIdsForSynthesisSet,
  listSynthesisSetIdsForSource,
  getSynthesisSetReadiness,
  getReadinessBySynthesisSetId,
} from "../src/db/synthesisSetSourcesRepo.js";
import { createYouTubeSource, createDiscordSource } from "../src/db/projectSourcesRepo.js";
import { createProjectSourceAnalysis } from "../src/db/projectSourceAnalysesRepo.js";
import { EMPTY_LESSON_KNOWLEDGE } from "../src/gemini/schema.js";
import { createTestPool, randomId } from "./helpers/testDb.js";

const pool = createTestPool();
afterAll(async () => {
  await pool.end();
});

async function makeProject(): Promise<{ id: number }> {
  const result = await pool.query<{ id: string }>(`INSERT INTO projects (name, project_type) VALUES ($1, 'TRADING_STRATEGIES') RETURNING id`, [randomId("proj")]);
  return { id: Number(result.rows[0].id) };
}

async function makeYouTubeSource(projectId: number) {
  const { source } = await createYouTubeSource(pool, { projectId, externalId: randomId("vid").slice(0, 11).padEnd(11, "0"), sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  return source;
}

async function makeDiscordSource(projectId: number) {
  const { source } = await createDiscordSource(pool, { projectId, externalId: randomId("attach"), sourceUrl: "https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1&is=2&hm=3" });
  return source;
}

async function markAnalyzed(projectSourceId: number) {
  const jobResult = await pool.query<{ job_id: string }>(
    `INSERT INTO project_source_analysis_jobs (project_source_id, analysis_fingerprint, status) VALUES ($1, $2, 'COMPLETED') RETURNING job_id`,
    [projectSourceId, randomId("fp")],
  );
  await createProjectSourceAnalysis(pool, {
    projectSourceId,
    jobId: jobResult.rows[0].job_id,
    status: "no_strategy",
    strategyFound: false,
    validatedJson: { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: EMPTY_LESSON_KNOWLEDGE },
    analysisSummary: "No strategy found.",
    model: "gemini-3.8-flash",
    promptVersion: "v2",
    extractorVersion: "v2",
    schemaVersion: "v2",
    analysisFingerprint: randomId("fp"),
    startedAt: new Date(),
    completedAt: new Date(),
    processingDurationSeconds: 10,
    inputTokens: 10,
    outputTokens: 10,
    thinkingTokens: 0,
    estimatedCost: 0.01,
  });
}

describe("synthesisSetSourcesRepo", () => {
  it("adds a source to a set", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);

    const { created } = await addSourceToSynthesisSet(pool, set.id, source.id);
    expect(created).toBe(true);
    expect(await listProjectSourceIdsForSynthesisSet(pool, set.id)).toEqual([source.id]);
  });

  it("removes a source from a set", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);
    await addSourceToSynthesisSet(pool, set.id, source.id);

    const removed = await removeSourceFromSynthesisSet(pool, set.id, source.id);
    expect(removed).toBe(true);
    expect(await listProjectSourceIdsForSynthesisSet(pool, set.id)).toEqual([]);
  });

  it("removing a source that was never a member returns false, never throws", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);
    expect(await removeSourceFromSynthesisSet(pool, set.id, source.id)).toBe(false);
  });

  it("duplicate membership is prevented — adding the same source twice never creates a second row (idempotent)", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);

    const first = await addSourceToSynthesisSet(pool, set.id, source.id);
    const second = await addSourceToSynthesisSet(pool, set.id, source.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM synthesis_set_sources WHERE synthesis_set_id = $1 AND project_source_id = $2`,
      [set.id, source.id],
    );
    expect(Number(countResult.rows[0].count)).toBe(1);
  });

  it("concurrent duplicate adds never both create a row (the PK is the real race-safety guarantee)", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);

    const [a, b, c] = await Promise.all([
      addSourceToSynthesisSet(pool, set.id, source.id),
      addSourceToSynthesisSet(pool, set.id, source.id),
      addSourceToSynthesisSet(pool, set.id, source.id),
    ]);
    expect([a, b, c].filter((r) => r.created).length).toBe(1);
  });

  it("CRITICAL: one source belongs to multiple synthesis sets — Source X in both A and B, Source Y only in A", async () => {
    const project = await makeProject();
    const setA = await createSynthesisSet(pool, { projectId: project.id, name: "Synthesis A", description: null });
    const setB = await createSynthesisSet(pool, { projectId: project.id, name: "Synthesis B", description: null });
    const sourceX = await makeYouTubeSource(project.id);
    const sourceY = await makeDiscordSource(project.id);

    await addSourceToSynthesisSet(pool, setA.id, sourceX.id);
    await addSourceToSynthesisSet(pool, setB.id, sourceX.id);
    await addSourceToSynthesisSet(pool, setA.id, sourceY.id);

    // Source X exists only once in the DB, but is visible in both sets.
    const membershipsOfX = await listSynthesisSetIdsForSource(pool, sourceX.id);
    expect(membershipsOfX.sort()).toEqual([setA.id, setB.id].sort());

    const membersOfA = await listProjectSourceIdsForSynthesisSet(pool, setA.id);
    const membersOfB = await listProjectSourceIdsForSynthesisSet(pool, setB.id);
    expect(membersOfA.sort()).toEqual([sourceX.id, sourceY.id].sort());
    expect(membersOfB).toEqual([sourceX.id]);

    // Removing X from A must not remove it from B.
    await removeSourceFromSynthesisSet(pool, setA.id, sourceX.id);
    expect(await listProjectSourceIdsForSynthesisSet(pool, setA.id)).toEqual([sourceY.id]);
    expect(await listProjectSourceIdsForSynthesisSet(pool, setB.id)).toEqual([sourceX.id]);

    // Deleting A must leave X and B (and Y) untouched.
    await pool.query(`DELETE FROM synthesis_sets WHERE id = $1`, [setA.id]);
    expect(await listProjectSourceIdsForSynthesisSet(pool, setB.id)).toEqual([sourceX.id]);
    const sourceYStillExists = await pool.query(`SELECT id FROM project_sources WHERE id = $1`, [sourceY.id]);
    expect(sourceYStillExists.rows).toHaveLength(1);
  });

  it("deleting a project_source removes its memberships (but the set itself survives)", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);
    await addSourceToSynthesisSet(pool, set.id, source.id);

    await pool.query(`DELETE FROM project_sources WHERE id = $1`, [source.id]);

    expect(await listProjectSourceIdsForSynthesisSet(pool, set.id)).toEqual([]);
    const setStillExists = await pool.query(`SELECT id FROM synthesis_sets WHERE id = $1`, [set.id]);
    expect(setStillExists.rows).toHaveLength(1);
  });

  it("deleting a synthesis set does NOT delete the source or its analysis", async () => {
    const project = await makeProject();
    const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
    const source = await makeYouTubeSource(project.id);
    await addSourceToSynthesisSet(pool, set.id, source.id);
    await markAnalyzed(source.id);

    await pool.query(`DELETE FROM synthesis_sets WHERE id = $1`, [set.id]);

    const sourceStillExists = await pool.query(`SELECT id FROM project_sources WHERE id = $1`, [source.id]);
    expect(sourceStillExists.rows).toHaveLength(1);
    const analysisStillExists = await pool.query(`SELECT analysis_id FROM project_source_analyses WHERE project_source_id = $1`, [source.id]);
    expect(analysisStillExists.rows).toHaveLength(1);
  });

  describe("readiness — the four important states", () => {
    it("State A: member + analyzed", async () => {
      const project = await makeProject();
      const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
      const source = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, set.id, source.id);
      await markAnalyzed(source.id);

      const readiness = await getSynthesisSetReadiness(pool, set.id);
      expect(readiness).toEqual({ sourceCount: 1, analyzedSourceCount: 1, needsAnalysisCount: 0 });
    });

    it("State B: member + not analyzed", async () => {
      const project = await makeProject();
      const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
      const source = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, set.id, source.id);

      const readiness = await getSynthesisSetReadiness(pool, set.id);
      expect(readiness).toEqual({ sourceCount: 1, analyzedSourceCount: 0, needsAnalysisCount: 1 });
    });

    it("States C/D: a non-member source (analyzed or not) never affects another set's readiness", async () => {
      const project = await makeProject();
      const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
      const memberSource = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, set.id, memberSource.id);

      const nonMemberAnalyzed = await makeDiscordSource(project.id);
      await markAnalyzed(nonMemberAnalyzed.id);
      const nonMemberUnanalyzed = await makeDiscordSource(project.id);
      void nonMemberUnanalyzed;

      const readiness = await getSynthesisSetReadiness(pool, set.id);
      expect(readiness.sourceCount).toBe(1);
    });

    it("mixed readiness: 3 selected, 2 analyzed, 1 needs analysis — never silently drops the unanalyzed one from the count", async () => {
      const project = await makeProject();
      const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
      const a = await makeYouTubeSource(project.id);
      const b = await makeDiscordSource(project.id);
      const c = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, set.id, a.id);
      await addSourceToSynthesisSet(pool, set.id, b.id);
      await addSourceToSynthesisSet(pool, set.id, c.id);
      await markAnalyzed(a.id);
      await markAnalyzed(c.id);

      const readiness = await getSynthesisSetReadiness(pool, set.id);
      expect(readiness).toEqual({ sourceCount: 3, analyzedSourceCount: 2, needsAnalysisCount: 1 });
    });

    it("getReadinessBySynthesisSetId computes readiness for multiple sets in one call, matching per-set results", async () => {
      const project = await makeProject();
      const setA = await createSynthesisSet(pool, { projectId: project.id, name: "A", description: null });
      const setB = await createSynthesisSet(pool, { projectId: project.id, name: "B", description: null });
      const source = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, setA.id, source.id);
      await markAnalyzed(source.id);

      const byId = await getReadinessBySynthesisSetId(pool, [setA.id, setB.id]);
      expect(byId.get(setA.id)).toEqual({ sourceCount: 1, analyzedSourceCount: 1, needsAnalysisCount: 0 });
      expect(byId.get(setB.id)).toBeUndefined(); // no rows for B — caller defaults to zero
    });

    it("re-analyzing a source (a second successful analysis row) still counts it as analyzed exactly once", async () => {
      const project = await makeProject();
      const set = await createSynthesisSet(pool, { projectId: project.id, name: "s", description: null });
      const source = await makeYouTubeSource(project.id);
      await addSourceToSynthesisSet(pool, set.id, source.id);
      await markAnalyzed(source.id);
      await markAnalyzed(source.id); // simulates a Re-analyze producing a second analysis row

      const readiness = await getSynthesisSetReadiness(pool, set.id);
      expect(readiness).toEqual({ sourceCount: 1, analyzedSourceCount: 1, needsAnalysisCount: 0 });
    });
  });
});
