import type { Pool } from "pg";

/**
 * Phase 4K-B (revised) — Discord user id -> Knovera identity (spec section
 * 10). `discordUserId` is always the stable Discord snowflake from a
 * signed interaction's `authorizing_integration_owners`/`user.id` (see
 * discord/discordInteractions.ts) — never a username/display name.
 */
export interface DiscordUserLinkRow {
  discordUserId: string;
  knoveraIdentity: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DiscordUserLinkDbRow {
  discord_user_id: string;
  knovera_identity: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: DiscordUserLinkDbRow): DiscordUserLinkRow {
  return { discordUserId: row.discord_user_id, knoveraIdentity: row.knovera_identity, createdAt: row.created_at, updatedAt: row.updated_at };
}

const COLUMNS = "discord_user_id, knovera_identity, created_at, updated_at";

export async function getKnoveraIdentityForDiscordUser(pool: Pool, discordUserId: string): Promise<DiscordUserLinkRow | null> {
  const result = await pool.query<DiscordUserLinkDbRow>(`SELECT ${COLUMNS} FROM discord_user_links WHERE discord_user_id = $1`, [discordUserId]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Every Discord account currently linked to this Knovera identity — powers the Sources page's "Discord account linked ✓" status (spec section 54). */
export async function listDiscordUserLinksForIdentity(pool: Pool, knoveraIdentity: string): Promise<DiscordUserLinkRow[]> {
  const result = await pool.query<DiscordUserLinkDbRow>(`SELECT ${COLUMNS} FROM discord_user_links WHERE knovera_identity = $1 ORDER BY created_at ASC`, [knoveraIdentity]);
  return result.rows.map(mapRow);
}

/** Unlinks every Discord account currently linked to this identity — spec section 54: "Unlinking Discord affects future captures only," never touches previously-captured content. */
export async function unlinkAllDiscordUsersForIdentity(pool: Pool, knoveraIdentity: string): Promise<void> {
  await pool.query(`DELETE FROM discord_user_links WHERE knovera_identity = $1`, [knoveraIdentity]);
}

/** Links (or re-links) a Discord user to a Knovera identity — idempotent, last-write-wins if ever re-linked to a different identity. */
export async function linkDiscordUserToIdentity(pool: Pool, discordUserId: string, knoveraIdentity: string): Promise<DiscordUserLinkRow> {
  const result = await pool.query<DiscordUserLinkDbRow>(
    `INSERT INTO discord_user_links (discord_user_id, knovera_identity) VALUES ($1, $2)
     ON CONFLICT (discord_user_id) DO UPDATE SET knovera_identity = EXCLUDED.knovera_identity, updated_at = now()
     RETURNING ${COLUMNS}`,
    [discordUserId, knoveraIdentity],
  );
  return mapRow(result.rows[0]);
}

/** Spec section 54 — "Unlink Discord affects future captures only." Never touches previously-captured content_assets/project_sources. */
export async function unlinkDiscordUser(pool: Pool, discordUserId: string): Promise<void> {
  await pool.query(`DELETE FROM discord_user_links WHERE discord_user_id = $1`, [discordUserId]);
}
