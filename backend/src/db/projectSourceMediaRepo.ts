import type { Pool } from "pg";

/**
 * Phase 4I durability fix — see the 1789600000000_project-source-media.sql
 * migration's comment for why this table exists at all: a Discord CDN
 * attachment's signed URL expires and can never be reconstructed later, so
 * the actual video bytes are captured once (while the pasted URL is fresh,
 * see http/routes/projectSources.ts's createAddDiscordSourceHandler) and
 * persisted here — every later acquisition (initial Analyze, every
 * Re-analyze) reads these bytes instead of ever touching the original URL
 * again (see worker/projectSourceAnalysisLoop.ts).
 */
export interface ProjectSourceMedia {
  projectSourceId: number;
  content: Buffer;
  contentType: string;
  byteSize: number;
  createdAt: Date;
}

interface ProjectSourceMediaRow {
  project_source_id: string;
  content: Buffer;
  content_type: string;
  byte_size: string;
  created_at: Date;
}

function mapRow(row: ProjectSourceMediaRow): ProjectSourceMedia {
  return {
    projectSourceId: Number(row.project_source_id),
    content: row.content,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    createdAt: row.created_at,
  };
}

const COLUMNS = "project_source_id, content, content_type, byte_size, created_at";

/** Insert-only in practice — a project_source's media is captured exactly once, at add-time. ON CONFLICT guards against an unexpected retry ever producing a duplicate-key error instead of just keeping the first successful capture. */
export async function saveProjectSourceMedia(
  pool: Pool,
  input: { projectSourceId: number; content: Buffer; contentType: string; byteSize: number },
): Promise<ProjectSourceMedia> {
  const result = await pool.query<ProjectSourceMediaRow>(
    `INSERT INTO project_source_media (project_source_id, content, content_type, byte_size)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_source_id) DO UPDATE SET content = EXCLUDED.content, content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size
     RETURNING ${COLUMNS}`,
    [input.projectSourceId, input.content, input.contentType, input.byteSize],
  );
  return mapRow(result.rows[0]);
}

export async function getProjectSourceMedia(pool: Pool, projectSourceId: number): Promise<ProjectSourceMedia | null> {
  const result = await pool.query<ProjectSourceMediaRow>(
    `SELECT ${COLUMNS} FROM project_source_media WHERE project_source_id = $1`,
    [projectSourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Used for the compensating cleanup when a Discord source's initial media download fails — see createAddDiscordSourceHandler. In normal operation this is unreachable via CASCADE (deleting the project_source itself removes this row), but the route deletes media explicitly first for clarity when it must undo a partially-created source. */
export async function deleteProjectSourceMedia(pool: Pool, projectSourceId: number): Promise<void> {
  await pool.query(`DELETE FROM project_source_media WHERE project_source_id = $1`, [projectSourceId]);
}
