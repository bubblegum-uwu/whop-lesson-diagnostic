import type { Pool } from "pg";

/**
 * Phase 4K-B (revised) — the shared durable-content layer (see the
 * 1790000000000_discord-user-capture.sql migration's doc comment).
 * `ownerIdentity` is the Knovera session's JWT subject
 * (req.knoveraOperator — see http/middleware/knoveraAuth.ts), never a new
 * accounts concept. DISCORD is the only provider that writes here today
 * (spec section 38's scope note).
 */
export type ContentAssetProvider = "DISCORD";

export interface ContentAssetRow {
  id: number;
  ownerIdentity: string;
  provider: ContentAssetProvider;
  externalId: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ContentAssetDbRow {
  id: string;
  owner_identity: string;
  provider: string;
  external_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ContentAssetDbRow): ContentAssetRow {
  return {
    id: Number(row.id),
    ownerIdentity: row.owner_identity,
    provider: row.provider as ContentAssetProvider,
    externalId: row.external_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, owner_identity, provider, external_id, title, created_at, updated_at";

export interface UpsertContentAssetInput {
  ownerIdentity: string;
  provider: ContentAssetProvider;
  externalId: string;
  title?: string | null;
}

/**
 * Race-safe upsert — same ON CONFLICT DO UPDATE + xmax=0 "was this a real
 * insert" convention as projectSourcesRepo.createYouTubeSource. Title is
 * backfilled (COALESCE, never clobbered) when previously unknown; never
 * re-downloads or re-touches content_asset_media, which only the caller's
 * `created: true` branch does.
 */
export async function upsertContentAsset(pool: Pool, input: UpsertContentAssetInput): Promise<{ asset: ContentAssetRow; created: boolean }> {
  const title = input.title ?? null;
  const result = await pool.query<ContentAssetDbRow & { inserted: boolean }>(
    `INSERT INTO content_assets (owner_identity, provider, external_id, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_identity, provider, external_id) DO UPDATE SET
       title = COALESCE(content_assets.title, EXCLUDED.title),
       updated_at = now()
     RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
    [input.ownerIdentity, input.provider, input.externalId, title],
  );
  const row = result.rows[0];
  return { asset: mapRow(row), created: row.inserted };
}

export async function getContentAssetById(pool: Pool, id: number): Promise<ContentAssetRow | null> {
  const result = await pool.query<ContentAssetDbRow>(`SELECT ${COLUMNS} FROM content_assets WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export interface ContentAssetMedia {
  contentAssetId: number;
  content: Buffer;
  contentType: string;
  byteSize: number;
  createdAt: Date;
}

export async function saveContentAssetMedia(pool: Pool, input: { contentAssetId: number; content: Buffer; contentType: string; byteSize: number }): Promise<void> {
  await pool.query(
    `INSERT INTO content_asset_media (content_asset_id, content, content_type, byte_size) VALUES ($1, $2, $3, $4)
     ON CONFLICT (content_asset_id) DO NOTHING`,
    [input.contentAssetId, input.content, input.contentType, input.byteSize],
  );
}

export async function getContentAssetMedia(pool: Pool, contentAssetId: number): Promise<ContentAssetMedia | null> {
  const result = await pool.query<{ content_asset_id: string; content: Buffer; content_type: string; byte_size: string; created_at: Date }>(
    `SELECT content_asset_id, content, content_type, byte_size, created_at FROM content_asset_media WHERE content_asset_id = $1`,
    [contentAssetId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { contentAssetId: Number(row.content_asset_id), content: row.content, contentType: row.content_type, byteSize: Number(row.byte_size), createdAt: row.created_at };
}

/** Compensating cleanup — mirrors projectSourcesRepo.deleteProjectSource's rationale: a freshly-created asset whose durable capture then failed must not linger as a permanently-broken row. Never used on an asset that already has media, or that any project_source references. */
export async function deleteContentAsset(pool: Pool, id: number): Promise<void> {
  await pool.query(`DELETE FROM content_assets WHERE id = $1`, [id]);
}
