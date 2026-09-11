import type { Pool } from "pg";

/**
 * Phase 4H-A — the first non-Whop project source. See the
 * 1789400000000_project-sources.sql migration's comment for why `provider`
 * is plain TEXT in the schema rather than a CHECK/ENUM: the allow-listing
 * of supported providers lives here, in application code, instead.
 *
 * Phase 4I adds 'DISCORD' here, exactly as that migration comment
 * anticipated — no migration required, purely an application-code
 * widening.
 */
export type ProjectSourceProvider = "YOUTUBE" | "DISCORD";

export const SUPPORTED_PROJECT_SOURCE_PROVIDERS: ReadonlySet<string> = new Set<ProjectSourceProvider>(["YOUTUBE", "DISCORD"]);

/**
 * Phase 4I — providers whose sources can be analyzed via the generic
 * project-source analysis pipeline (see http/routes/projectSourceAnalysis.ts
 * and worker/projectSourceAnalysisLoop.ts). Every currently-supported
 * provider is analyzable today; kept as its own named set (rather than
 * reusing SUPPORTED_PROJECT_SOURCE_PROVIDERS directly at each call site) so
 * a future provider that's storable-but-not-yet-analyzable (mirroring how
 * GENERAL_KNOWLEDGE projects can store but not analyze YouTube/Discord
 * sources today) doesn't require touching every analysis call site.
 */
export const ANALYZABLE_PROJECT_SOURCE_PROVIDERS: ReadonlySet<string> = new Set<ProjectSourceProvider>(["YOUTUBE", "DISCORD"]);

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
  /** Phase 4K — the source_collections row this item was discovered through, or null for an à-la-carte item never imported via a collection (see 1789800000000_source-collections.sql). */
  collectionId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateYouTubeSourceInput {
  projectId: number;
  externalId: string;
  sourceUrl: string;
  /** Phase 4K — set when created via channel discovery (see sourceCollectionsRepo.ts); omitted/null for an à-la-carte add, exactly like before. */
  collectionId?: number | null;
  /** Phase 4K — channel discovery already knows the video's title; à-la-carte add still never fetches one. */
  title?: string | null;
}

export interface CreateDiscordSourceInput {
  projectId: number;
  externalId: string;
  sourceUrl: string;
  /** Phase 4K-B — set when created via channel discovery (see discord/discordChannels.ts); omitted/null for an à-la-carte add, exactly like before. */
  collectionId?: number | null;
  /** Phase 4K-B — channel discovery knows the attachment's filename; à-la-carte add still never fetches one. */
  title?: string | null;
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
  collection_id: string | null;
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
    collectionId: row.collection_id == null ? null : Number(row.collection_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  "id, project_id, provider, external_id, source_url, title, duration_seconds, status, error_message, collection_id, created_at, updated_at";

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
 *
 * Phase 4K — `collectionId`/`title` extend this for channel discovery
 * without changing à-la-carte behavior at all (both default to null,
 * identical to the pre-Phase-4K INSERT). When the same video already
 * exists (added à-la-carte, or already a member of a DIFFERENT sync of
 * the same collection), the conflict branch ADOPTS it into the collection
 * — `collection_id = COALESCE(project_sources.collection_id, EXCLUDED.collection_id)`
 * never clobbers an existing association, it only fills one in when the
 * row had none — and backfills a NULL title the same way, but never
 * touches `project_source_analyses`/`project_source_analysis_jobs`: this
 * is the exact same row (same id), so its full analysis history is
 * preserved automatically (Phase 4K spec sections 17/39).
 */
export async function createYouTubeSource(
  pool: Pool,
  input: CreateYouTubeSourceInput,
): Promise<{ source: ProjectSourceRow; created: boolean }> {
  const collectionId = input.collectionId ?? null;
  const title = input.title ?? null;
  const inserted = await pool.query<ProjectSourceDbRow>(
    `INSERT INTO project_sources (project_id, provider, external_id, source_url, title, duration_seconds, status, collection_id)
     VALUES ($1, 'YOUTUBE', $2, $3, $4, NULL, 'READY', $5)
     ON CONFLICT (project_id, provider, external_id) DO UPDATE SET
       collection_id = COALESCE(project_sources.collection_id, EXCLUDED.collection_id),
       title = COALESCE(project_sources.title, EXCLUDED.title),
       updated_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [input.projectId, input.externalId, input.sourceUrl, title, collectionId],
  );
  const row = inserted.rows[0] as ProjectSourceDbRow & { inserted: boolean };
  return { source: mapRow(row), created: row.inserted };
}

/**
 * Phase 4I — the second project_sources writer, mirroring
 * createYouTubeSource's shape (same READY status; since Phase 4K-B, the
 * same ON CONFLICT DO UPDATE + xmax=0 adopt-vs-create dedup for
 * collection_id/title — an attachment imported à la carte and later
 * discovered via channel sync, or vice versa, stays ONE row, never
 * duplicated — spec section 16/35/36). `sourceUrl` here is the exact,
 * verbatim Discord CDN URL (signature included) — see lib/discordUrl.ts's
 * doc comment on why it can't be normalized down to an id the way
 * YouTube's can. This URL is used ONLY once, immediately after the row
 * that first captures it is created, to durably capture the video's bytes
 * (see discord/downloadDiscordAttachment.ts / db/projectSourceMediaRepo.ts)
 * — it is never relied on again afterward (never overwritten on conflict
 * either — a later, possibly-fresher signed URL for an already-captured
 * attachment is simply never needed again), since its signature expires
 * and cannot be reconstructed later.
 */
export async function createDiscordSource(
  pool: Pool,
  input: CreateDiscordSourceInput,
): Promise<{ source: ProjectSourceRow; created: boolean }> {
  const collectionId = input.collectionId ?? null;
  const title = input.title ?? null;
  const inserted = await pool.query<ProjectSourceDbRow>(
    `INSERT INTO project_sources (project_id, provider, external_id, source_url, title, duration_seconds, status, collection_id)
     VALUES ($1, 'DISCORD', $2, $3, $4, NULL, 'READY', $5)
     ON CONFLICT (project_id, provider, external_id) DO UPDATE SET
       collection_id = COALESCE(project_sources.collection_id, EXCLUDED.collection_id),
       title = COALESCE(project_sources.title, EXCLUDED.title),
       updated_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [input.projectId, input.externalId, input.sourceUrl, title, collectionId],
  );
  const row = inserted.rows[0] as ProjectSourceDbRow & { inserted: boolean };
  return { source: mapRow(row), created: row.inserted };
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

/**
 * Phase 4I durability fix — the ONE compensating-cleanup use case this
 * writer exists for: createAddDiscordSourceHandler creates a project_source
 * row, then immediately attempts to durably capture its video bytes (see
 * project_source_media). If that capture fails, the just-created row would
 * be permanently unanalyzable (its media never captured, and its
 * originally-pasted signed URL likely stale by the time anyone retries),
 * so the route deletes it here rather than leaving a broken row behind —
 * the user simply re-submits with a fresh link. Never used to delete a
 * source that has ever successfully completed creation with its media
 * intact.
 */
export async function deleteProjectSource(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM project_sources WHERE id = $1`, [id]);
}
