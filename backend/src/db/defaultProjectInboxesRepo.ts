import type { Pool } from "pg";
import { getProjectById, type Project } from "./projectsRepo.js";

/**
 * Phase 4K-B (revised) — "Discord Knowledge," the permanent Discord
 * capture inbox (spec section 7/8/9). One row per (Knovera identity,
 * purpose) — today only ever `purpose = 'discord_knowledge'` — mapping to
 * the auto-created project, so it is identified structurally, never by
 * matching `projects.name` at read time.
 */
export const DISCORD_KNOWLEDGE_PURPOSE = "discord_knowledge";
export const DISCORD_KNOWLEDGE_PROJECT_NAME = "Discord Knowledge";

/**
 * Returns the identity's Discord Knowledge project, creating both the
 * project (type GENERAL_KNOWLEDGE) and the mapping row on first use —
 * spec section 9: if a previous mapping's project was since deleted, this
 * transparently recreates a fresh one rather than routing captures into
 * an arbitrary existing project.
 */
export async function ensureDiscordKnowledgeProject(pool: Pool, knoveraIdentity: string): Promise<Project> {
  const existing = await pool.query<{ project_id: string }>(
    `SELECT project_id FROM default_project_inboxes WHERE knovera_identity = $1 AND purpose = $2`,
    [knoveraIdentity, DISCORD_KNOWLEDGE_PURPOSE],
  );
  if (existing.rows[0]) {
    const project = await getProjectById(pool, Number(existing.rows[0].project_id));
    if (project) return project;
    // The mapped project was deleted out from under us — spec section 9's
    // "recreate Discord Knowledge, update inbox mapping" path. Falls
    // through to the create-and-map logic below, replacing the stale row.
  }

  // First-ever (or post-deletion) creation only: guarded by a per-identity
  // advisory lock (Postgres's own hashtext(), not a hand-rolled hash) so
  // two concurrent captures for the same brand-new identity can never both
  // create a separate "Discord Knowledge" project — the second caller
  // blocks here, then re-checks the mapping (now present) instead of
  // racing createProject. Ordinary reuse (the common case, above) never
  // takes this lock at all.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`discord_knowledge:${knoveraIdentity}`]);
    const recheck = await client.query<{ project_id: string }>(
      `SELECT project_id FROM default_project_inboxes WHERE knovera_identity = $1 AND purpose = $2`,
      [knoveraIdentity, DISCORD_KNOWLEDGE_PURPOSE],
    );
    if (recheck.rows[0]) {
      const project = await getProjectById(pool, Number(recheck.rows[0].project_id));
      if (project) {
        await client.query("COMMIT");
        return project;
      }
    }
    const projectResult = await client.query<{ id: string; name: string; project_type: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO projects (name, project_type) VALUES ($1, 'GENERAL_KNOWLEDGE') RETURNING id, name, project_type, created_at, updated_at`,
      [DISCORD_KNOWLEDGE_PROJECT_NAME],
    );
    const row = projectResult.rows[0];
    await client.query(
      `INSERT INTO default_project_inboxes (knovera_identity, purpose, project_id) VALUES ($1, $2, $3)
       ON CONFLICT (knovera_identity, purpose) DO UPDATE SET project_id = EXCLUDED.project_id`,
      [knoveraIdentity, DISCORD_KNOWLEDGE_PURPOSE, row.id],
    );
    await client.query("COMMIT");
    return { id: Number(row.id), name: row.name, projectType: row.project_type as Project["projectType"], createdAt: row.created_at, updatedAt: row.updated_at };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
