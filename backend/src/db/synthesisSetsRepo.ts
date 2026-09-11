import type { Pool } from "pg";

/**
 * Phase 4J — a persistent, named configuration: "these sources should be
 * synthesized together." NOT a completed synthesis result and NOT a
 * synthesis execution — see the 1789700000000_synthesis-sets.sql
 * migration's comment for the full "why," and synthesisSetSourcesRepo.ts
 * for membership.
 */
export interface SynthesisSetRow {
  id: number;
  projectId: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SynthesisSetDbRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: SynthesisSetDbRow): SynthesisSetRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, project_id, name, description, created_at, updated_at";

export interface CreateSynthesisSetInput {
  projectId: number;
  name: string;
  description: string | null;
}

export async function createSynthesisSet(pool: Pool, input: CreateSynthesisSetInput): Promise<SynthesisSetRow> {
  const result = await pool.query<SynthesisSetDbRow>(
    `INSERT INTO synthesis_sets (project_id, name, description) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
    [input.projectId, input.name, input.description],
  );
  return mapRow(result.rows[0]);
}

export async function listSynthesisSetsByProjectId(pool: Pool, projectId: number): Promise<SynthesisSetRow[]> {
  const result = await pool.query<SynthesisSetDbRow>(
    `SELECT ${COLUMNS} FROM synthesis_sets WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId],
  );
  return result.rows.map(mapRow);
}

/**
 * Callers MUST additionally check `set.projectId === requestedProjectId`
 * themselves (never rely on setId alone) — same ownership convention as
 * projectSourcesRepo.getProjectSourceById.
 */
export async function getSynthesisSetById(pool: Pool, id: number): Promise<SynthesisSetRow | null> {
  const result = await pool.query<SynthesisSetDbRow>(`SELECT ${COLUMNS} FROM synthesis_sets WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export interface UpdateSynthesisSetInput {
  name?: string;
  description?: string | null;
}

/** Rename/description only — nothing else about a Synthesis Set is mutable in Phase 4J. Returns null if the row doesn't exist (caller already resolved ownership before calling this, so that should only happen on a genuine race). */
export async function updateSynthesisSet(pool: Pool, id: number, input: UpdateSynthesisSetInput): Promise<SynthesisSetRow | null> {
  const result = await pool.query<SynthesisSetDbRow>(
    `UPDATE synthesis_sets
     SET name = COALESCE($2, name), description = CASE WHEN $3 THEN $4 ELSE description END, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, input.name ?? null, input.description !== undefined, input.description ?? null],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Deletes the set. Memberships cascade (synthesis_set_sources.synthesis_set_id ON DELETE CASCADE) — the sources themselves and their analyses are never touched, since this table has no FK pointing the other direction. */
export async function deleteSynthesisSet(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM synthesis_sets WHERE id = $1`, [id]);
}
