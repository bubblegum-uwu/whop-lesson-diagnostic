import type { Pool } from "pg";

/**
 * Phase 4H-A — the first non-Whop project source. See the
 * 1789400000000_project-sources.sql migration's comment for why `provider`
 * is plain TEXT in the schema rather than a CHECK/ENUM: the allow-listing
 * of supported providers lives here, in application code, instead.
 */
export type ProjectSourceProvider = "YOUTUBE";

/** Phase 4I adds 'DISCORD' here, not in a migration — see the schema comment. */
export const SUPPORTED_PROJECT_SOURCE_PROVIDERS: ReadonlySet<string> = new Set<ProjectSourceProvider>(["YOUTUBE"]);

/** Source-record readiness, never analysis readiness — Phase 4H-A never runs an analysis, so every row it creates is READY the moment it's inserted. */
export type ProjectSourceStatus = "READY" | "FAILED";

export interface ProjectSourceRow {
  id: number;
  projectId: number;
  provider: ProjectSourceProvider;
  externalId: string;
  sourceUrl: string;
  title: string | null;
  durationSeconds: number | null;
  status: ProjectSourceStatus;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateYouTubeSourceInput {
  projectId: number;
  externalId: string;
  sourceUrl: string;
}

interface ProjectSourceDbRow {
  id: string;
  project_id: string;
  provider: string;
  external_id: string;
  source_url: string;
  title: string | null;
  duration_seconds: number | null;
  status: string;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ProjectSourceDbRow): ProjectSourceRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    provider: row.provider as ProjectSourceProvider,
    externalId: row.external_id,
    sourceUrl: row.source_url,
    title: row.title,
    durationSeconds: row.duration_seconds,
    status: row.status as ProjectSourceStatus,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, project_id, provider, external_id, source_url, title, duration_seconds, status, error_message, created_at, updated_at";

/**
 * Phase 4H-A — the ONLY writer of `project_sources` this phase ships.
 * `provider` is always the literal 'YOUTUBE' (never caller-supplied) — see
 * SUPPORTED_PROJECT_SOURCE_PROVIDERS above for what "application-level
 * allow-listing" means in practice today. No title/duration is ever
 * fetched or fabricated here (Phase 4H-A performs no network
 * acquisition) — both are stored NULL, and `status` is always 'READY': a
 * stored source record is complete the moment this INSERT commits,
 * independent of whether it has ever been analyzed.
 *
 * Race-safety: `project_sources`'s UNIQUE(project_id, provider,
 * external_id) constraint (see the migration) is the actual duplicate
 * guarantee — this function never does a check-then-insert. `ON CONFLICT
 * DO NOTHING` plus a follow-up SELECT distinguishes "this exact row
 * already existed" (`created: false`) from a genuine insert (`created:
 * true`) without raising a raw unique-violation error to the caller, and
 * without a second transaction — two concurrent requests for the same
 * (project, video) can never both "win".
 */
export async function createYouTubeSource(
  pool: Pool,
  input: CreateYouTubeSourceInput,
): Promise<{ source: ProjectSourceRow; created: boolean }> {
  const inserted = await pool.query<ProjectSourceDbRow>(
    `INSERT INTO project_sources (project_id, provider, external_id, source_url, title, duration_seconds, status)
     VALUES ($1, 'YOUTUBE', $2, $3, NULL, NULL, 'READY')
     ON CONFLICT (project_id, provider, external_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.projectId, input.externalId, input.sourceUrl],
  );
  if (inserted.rows[0]) {
    return { source: mapRow(inserted.rows[0]), created: true };
  }

  const existing = await pool.query<ProjectSourceDbRow>(
    `SELECT ${COLUMNS} FROM project_sources WHERE project_id = $1 AND provider = 'YOUTUBE' AND external_id = $2`,
    [input.projectId, input.externalId],
  );
  // The row must exist — the ON CONFLICT above only fires because a row
  // matching this exact (project_id, provider, external_id) already does.
  return { source: mapRow(existing.rows[0]), created: false };
}

/** Every source this project owns, across all providers — scoped by project_id alone, never a global fallback. */
export async function listProjectSourcesByProjectId(pool: Pool, projectId: number): Promise<ProjectSourceRow[]> {
  const result = await pool.query<ProjectSourceDbRow>(
    `SELECT ${COLUMNS} FROM project_sources WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId],
  );
  return result.rows.map(mapRow);
}

/**
 * Phase 4H-B — a single source by id, used by the analyze/retry/analysis
 * routes and the worker. Callers MUST additionally check
 * `source.projectId === requestedProjectId` themselves (never rely on
 * sourceId alone) — see http/routes/projectSourceAnalysis.ts's ownership
 * check.
 */
export async function getProjectSourceById(pool: Pool, id: number): Promise<ProjectSourceRow | null> {
  const result = await pool.query<ProjectSourceDbRow>(`SELECT ${COLUMNS} FROM project_sources WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}
