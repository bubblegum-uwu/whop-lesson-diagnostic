import type { Pool } from "pg";

/**
 * Phase 4K — the provider-independent collection layer above
 * project_sources, for providers with no native grouping entity of their
 * own (YouTube channels, Discord channels/collections). See the
 * 1789800000000_source-collections.sql migration's comment for why Whop
 * is deliberately NOT represented here — a Whop course already IS a
 * project-scoped collection (`courses`, via `courses.project_id`).
 */
export type SourceCollectionProvider = "YOUTUBE" | "DISCORD";
export type SourceCollectionStatus = "READY" | "SYNCING" | "SYNC_FAILED";

export const SUPPORTED_COLLECTION_PROVIDERS: ReadonlySet<string> = new Set<SourceCollectionProvider>(["YOUTUBE", "DISCORD"]);

export interface SourceCollectionRow {
  id: number;
  projectId: number;
  provider: SourceCollectionProvider;
  externalId: string;
  title: string;
  sourceUrl: string;
  status: SourceCollectionStatus;
  sanitizedError: string | null;
  lastSyncedAt: Date | null;
  /** Phase 4K follow-up — see the migration's doc comment. Non-null means a deeper discovery pass is still pending (more, older videos exist beyond the last discovery/refresh call's page cap). Always null for DISCORD. */
  discoveryCursor: string | null;
  /** Phase 4K-B review fix — which connected discord_guilds row this channel belongs to (null for YOUTUBE, and for any legacy/edge-case DISCORD row with no guild backlink). Read by discord/discordChannels.ts's refreshDiscordCollection to check the requesting identity's authorization for THIS channel's guild before refreshing it — see discord_guild_authorizations's doc comment. */
  discordGuildId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface CollectionDbRow {
  id: string;
  project_id: string;
  provider: string;
  external_id: string;
  title: string;
  source_url: string;
  status: SourceCollectionStatus;
  sanitized_error: string | null;
  last_synced_at: Date | null;
  discovery_cursor: string | null;
  discord_guild_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CollectionDbRow): SourceCollectionRow {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    provider: row.provider as SourceCollectionProvider,
    externalId: row.external_id,
    title: row.title,
    sourceUrl: row.source_url,
    status: row.status,
    sanitizedError: row.sanitized_error,
    lastSyncedAt: row.last_synced_at,
    discoveryCursor: row.discovery_cursor,
    discordGuildId: row.discord_guild_id !== null ? Number(row.discord_guild_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, project_id, provider, external_id, title, source_url, status, sanitized_error, last_synced_at, discovery_cursor, discord_guild_id, created_at, updated_at";

export interface CreateSourceCollectionInput {
  projectId: number;
  provider: SourceCollectionProvider;
  externalId: string;
  title: string;
  sourceUrl: string;
}

/**
 * Race-safe, same ON CONFLICT DO NOTHING + follow-up SELECT convention as
 * projectSourcesRepo.createDiscordSource — the UNIQUE(project_id,
 * provider, external_id) constraint is the actual duplicate guarantee.
 * `created: false` means "this collection was already connected to this
 * project" — the caller (http/routes/sourceCollections.ts) treats that as
 * the existing collection, never a validation error, matching Phase 4J's
 * own idempotent-add convention.
 */
export async function createSourceCollection(pool: Pool, input: CreateSourceCollectionInput): Promise<{ collection: SourceCollectionRow; created: boolean }> {
  const inserted = await pool.query<CollectionDbRow>(
    `INSERT INTO source_collections (project_id, provider, external_id, title, source_url, status, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, 'READY', now())
     ON CONFLICT (project_id, provider, external_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.projectId, input.provider, input.externalId, input.title, input.sourceUrl],
  );
  if (inserted.rows[0]) {
    return { collection: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<CollectionDbRow>(
    `SELECT ${COLUMNS} FROM source_collections WHERE project_id = $1 AND provider = $2 AND external_id = $3`,
    [input.projectId, input.provider, input.externalId],
  );
  return { collection: mapRow(existing.rows[0]), created: false };
}

export async function getSourceCollectionById(pool: Pool, id: number): Promise<SourceCollectionRow | null> {
  const result = await pool.query<CollectionDbRow>(`SELECT ${COLUMNS} FROM source_collections WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Every collection this project owns, across YouTube/Discord — never another project's, never Whop's (see courses.project_id for that). */
export async function listSourceCollectionsByProjectId(pool: Pool, projectId: number): Promise<SourceCollectionRow[]> {
  const result = await pool.query<CollectionDbRow>(`SELECT ${COLUMNS} FROM source_collections WHERE project_id = $1 ORDER BY created_at ASC`, [projectId]);
  return result.rows.map(mapRow);
}

/**
 * Refresh bookkeeping: updates title (a channel may have been renamed),
 * the discovery pagination cursor (see the migration's doc comment — null
 * once a discovery pass reaches the end of the channel's history, or has
 * caught up to previously-known videos; non-null when a deeper pass is
 * still pending), and last_synced_at/status on every successful
 * discovery/refresh pass — never touches membership
 * (project_sources.collection_id) or any existing item's analysis.
 */
export async function markCollectionSynced(pool: Pool, id: number, title: string, discoveryCursor: string | null = null): Promise<void> {
  await pool.query(
    `UPDATE source_collections SET title = $2, status = 'READY', sanitized_error = NULL, discovery_cursor = $3, last_synced_at = now(), updated_at = now() WHERE id = $1`,
    [id, title, discoveryCursor],
  );
}

export async function markCollectionSyncFailed(pool: Pool, id: number, sanitizedError: string): Promise<void> {
  await pool.query(`UPDATE source_collections SET status = 'SYNC_FAILED', sanitized_error = $2, updated_at = now() WHERE id = $1`, [id, sanitizedError]);
}

/**
 * Removes the collection ROW only. The composite project-isolation FK
 * (see the migration) is NOT "ON DELETE SET NULL" — a composite FK's SET
 * NULL would null every column in its list, including project_id, which
 * must stay NOT NULL — so this function explicitly clears
 * `collection_id` on every member in the SAME transaction, immediately
 * before deleting the collection row. Items and their analyses are never
 * deleted (Phase 4K spec section 40's recommended, and here the only
 * implemented, behavior: "Remove Collection → remove collection
 * association → preserve underlying imported items").
 */
export async function deleteSourceCollection(pool: Pool, id: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE project_sources SET collection_id = NULL, updated_at = now() WHERE collection_id = $1`, [id]);
    await client.query(`DELETE FROM source_collections WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
