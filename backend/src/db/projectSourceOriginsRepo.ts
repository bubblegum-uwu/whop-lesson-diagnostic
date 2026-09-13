import type { Pool } from "pg";

/**
 * Phase 4K-C — provenance/origin records for project_sources. A single
 * YouTube project_source can carry many of these (one manual add plus any
 * number of distinct Discord channel postings/reposts) — see the
 * 1790200000000_project-source-origins.sql migration's doc comment for the
 * full reasoning and the two idempotency guarantees this repo relies on
 * (a partial unique index per origin type, enforced here via ON CONFLICT
 * targeting that index, never an application-level check-then-insert).
 */
export type ProjectSourceOriginType = "MANUAL" | "DISCORD_CHANNEL";

export interface ProjectSourceOriginRow {
  id: number;
  projectSourceId: number;
  originType: ProjectSourceOriginType;
  discordGuildId: string | null;
  discordChannelId: string | null;
  discordChannelName: string | null;
  discordMessageId: string | null;
  discordMessageUrl: string | null;
  /** The Discord MESSAGE's timestamp — never YouTube's publish date, this row's own createdAt, or a scan/analysis timestamp. Null for MANUAL. */
  discordPostedAt: Date | null;
  createdAt: Date;
}

interface OriginDbRow {
  id: string;
  project_source_id: string;
  origin_type: string;
  discord_guild_id: string | null;
  discord_channel_id: string | null;
  discord_channel_name: string | null;
  discord_message_id: string | null;
  discord_message_url: string | null;
  discord_posted_at: Date | null;
  created_at: Date;
}

function mapRow(row: OriginDbRow): ProjectSourceOriginRow {
  return {
    id: Number(row.id),
    projectSourceId: Number(row.project_source_id),
    originType: row.origin_type as ProjectSourceOriginType,
    discordGuildId: row.discord_guild_id,
    discordChannelId: row.discord_channel_id,
    discordChannelName: row.discord_channel_name,
    discordMessageId: row.discord_message_id,
    discordMessageUrl: row.discord_message_url,
    discordPostedAt: row.discord_posted_at,
    createdAt: row.created_at,
  };
}

const COLUMNS =
  "id, project_source_id, origin_type, discord_guild_id, discord_channel_id, discord_channel_name, discord_message_id, discord_message_url, discord_posted_at, created_at";

/**
 * Idempotent: ON CONFLICT targets project_source_origins_manual_unique (a
 * MANUAL origin is unique per source). `created: false` means this source
 * already had a MANUAL origin — the existing row is returned, no duplicate
 * is ever inserted, whether the caller is adding a brand-new source or
 * manually re-adding one that already exists (e.g. one discovered via
 * Discord earlier).
 */
export async function insertManualOrigin(pool: Pool, projectSourceId: number): Promise<{ origin: ProjectSourceOriginRow; created: boolean }> {
  const inserted = await pool.query<OriginDbRow>(
    `INSERT INTO project_source_origins (project_source_id, origin_type)
     VALUES ($1, 'MANUAL')
     ON CONFLICT (project_source_id) WHERE origin_type = 'MANUAL' DO NOTHING
     RETURNING ${COLUMNS}`,
    [projectSourceId],
  );
  if (inserted.rows[0]) {
    return { origin: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<OriginDbRow>(
    `SELECT ${COLUMNS} FROM project_source_origins WHERE project_source_id = $1 AND origin_type = 'MANUAL'`,
    [projectSourceId],
  );
  return { origin: mapRow(existing.rows[0]), created: false };
}

export interface InsertDiscordChannelOriginInput {
  projectSourceId: number;
  guildId: string;
  channelId: string;
  /** Null when the browser companion couldn't safely derive a channel name — the caller falls back to displaying channelId, never a fabricated name. */
  channelName: string | null;
  messageId: string;
  /** Null when a permalink couldn't be safely derived from the scan. */
  messageUrl: string | null;
  postedAt: Date;
}

/**
 * Idempotent: ON CONFLICT targets
 * project_source_origins_discord_message_unique (project_source_id,
 * discord_channel_id, discord_message_id) — re-scanning the same channel
 * and re-encountering the same message never creates a second row
 * (`created: false`, the existing occurrence is returned unchanged). A
 * different message id (a repost) or a different channel id (the same
 * video shared elsewhere) each insert their own new row, by design.
 */
export async function insertDiscordChannelOrigin(
  pool: Pool,
  input: InsertDiscordChannelOriginInput,
): Promise<{ origin: ProjectSourceOriginRow; created: boolean }> {
  const inserted = await pool.query<OriginDbRow>(
    `INSERT INTO project_source_origins
       (project_source_id, origin_type, discord_guild_id, discord_channel_id, discord_channel_name, discord_message_id, discord_message_url, discord_posted_at)
     VALUES ($1, 'DISCORD_CHANNEL', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (project_source_id, discord_channel_id, discord_message_id) WHERE origin_type = 'DISCORD_CHANNEL' DO NOTHING
     RETURNING ${COLUMNS}`,
    [input.projectSourceId, input.guildId, input.channelId, input.channelName, input.messageId, input.messageUrl, input.postedAt],
  );
  if (inserted.rows[0]) {
    return { origin: mapRow(inserted.rows[0]), created: true };
  }
  const existing = await pool.query<OriginDbRow>(
    `SELECT ${COLUMNS} FROM project_source_origins
     WHERE project_source_id = $1 AND origin_type = 'DISCORD_CHANNEL' AND discord_channel_id = $2 AND discord_message_id = $3`,
    [input.projectSourceId, input.channelId, input.messageId],
  );
  return { origin: mapRow(existing.rows[0]), created: false };
}

/**
 * Batched (never N+1) — every origin for every requested source, grouped
 * by project_source_id, oldest first. An id with no origins simply has no
 * entry in the returned map (see the caller in http/routes/projectSources.ts
 * for why that renders as "no provenance known," never a fabricated
 * "Manual" label — the historical-backfill rule from the Phase 4K-C spec).
 */
export async function listOriginsBySourceIds(pool: Pool, projectSourceIds: number[]): Promise<Map<number, ProjectSourceOriginRow[]>> {
  const map = new Map<number, ProjectSourceOriginRow[]>();
  if (projectSourceIds.length === 0) {
    return map;
  }
  const result = await pool.query<OriginDbRow>(
    `SELECT ${COLUMNS} FROM project_source_origins WHERE project_source_id = ANY($1::bigint[]) ORDER BY created_at ASC`,
    [projectSourceIds],
  );
  for (const row of result.rows) {
    const mapped = mapRow(row);
    const list = map.get(mapped.projectSourceId);
    if (list) {
      list.push(mapped);
    } else {
      map.set(mapped.projectSourceId, [mapped]);
    }
  }
  return map;
}
