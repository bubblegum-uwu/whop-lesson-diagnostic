import type { Pool } from "pg";

/**
 * Phase 4K-B — see the 1790000000000_discord-collections.sql migration's
 * doc comment: a deployment-wide record of which Discord guilds the
 * shared bot identity has been added to. No secret lives here — every
 * field is safe to return verbatim from an API response.
 */
export type DiscordGuildStatus = "CONNECTED" | "DISCONNECTED";

export interface DiscordGuildRow {
  id: number;
  guildId: string;
  guildName: string;
  status: DiscordGuildStatus;
  connectedAt: Date;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DiscordGuildDbRow {
  id: string;
  guild_id: string;
  guild_name: string;
  status: DiscordGuildStatus;
  connected_at: Date;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DiscordGuildDbRow): DiscordGuildRow {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    guildName: row.guild_name,
    status: row.status,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COLUMNS = "id, guild_id, guild_name, status, connected_at, disconnected_at, created_at, updated_at";

/**
 * Called after a successful bot-install OAuth callback. Idempotent: adding
 * an already-known guild again (the operator re-runs "Connect Discord" and
 * picks the same server, or reconnects after a prior disconnect) reactivates
 * it (status back to CONNECTED) rather than erroring or creating a second
 * row — the guild's Discord-assigned id is the natural, permanent identity.
 */
export async function upsertDiscordGuild(pool: Pool, guildId: string, guildName: string): Promise<DiscordGuildRow> {
  const result = await pool.query<DiscordGuildDbRow>(
    `INSERT INTO discord_guilds (guild_id, guild_name, status, connected_at)
     VALUES ($1, $2, 'CONNECTED', now())
     ON CONFLICT (guild_id) DO UPDATE SET
       guild_name = EXCLUDED.guild_name,
       status = 'CONNECTED',
       connected_at = now(),
       disconnected_at = NULL,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [guildId, guildName],
  );
  return mapRow(result.rows[0]);
}

export async function getDiscordGuildById(pool: Pool, id: number): Promise<DiscordGuildRow | null> {
  const result = await pool.query<DiscordGuildDbRow>(`SELECT ${COLUMNS} FROM discord_guilds WHERE id = $1`, [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function getDiscordGuildByGuildId(pool: Pool, guildId: string): Promise<DiscordGuildRow | null> {
  const result = await pool.query<DiscordGuildDbRow>(`SELECT ${COLUMNS} FROM discord_guilds WHERE guild_id = $1`, [guildId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Every guild the bot has ever been connected to — CONNECTED and DISCONNECTED alike; callers filter for what they need (e.g. the connect UI only offers CONNECTED ones for channel import). */
export async function listDiscordGuilds(pool: Pool): Promise<DiscordGuildRow[]> {
  const result = await pool.query<DiscordGuildDbRow>(`SELECT ${COLUMNS} FROM discord_guilds ORDER BY connected_at DESC`);
  return result.rows.map(mapRow);
}

/** Marks a guild disconnected — stops it appearing as importable and stops future refresh (http/routes/discordConnections.ts's disconnect handler also best-effort leaves the guild via the Discord API). Never deletes the row or touches any source_collections/project_sources it already produced — those, and their analyses, are untouched (spec section 26). */
export async function markDiscordGuildDisconnected(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE discord_guilds SET status = 'DISCONNECTED', disconnected_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
