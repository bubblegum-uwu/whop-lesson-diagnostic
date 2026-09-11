import type { Pool } from "pg";

/**
 * Phase 4K-B review fix — see the 1790100000000_discord-guild-authorizations.sql
 * migration's doc comment for the three-layer model this table implements
 * (bot installation / identity-to-guild authorization / project-to-channel
 * membership). `knoveraIdentity` is req.knoveraOperator (the verified
 * Knovera session's JWT subject — http/middleware/knoveraAuth.ts), never a
 * new accounts concept of its own.
 */

/** Idempotent — granting an already-authorized (guild, identity) pair again is a no-op, never an error (e.g. reconnecting a guild the same identity already authorized). */
export async function authorizeDiscordGuildForIdentity(pool: Pool, discordGuildId: number, knoveraIdentity: string): Promise<void> {
  await pool.query(
    `INSERT INTO discord_guild_authorizations (discord_guild_id, knovera_identity) VALUES ($1, $2)
     ON CONFLICT (discord_guild_id, knovera_identity) DO NOTHING`,
    [discordGuildId, knoveraIdentity],
  );
}

/** The one check every guild/channel-scoped route makes before doing anything else — see discord/discordConnections.ts and discord/discordChannels.ts. */
export async function isDiscordGuildAuthorizedForIdentity(pool: Pool, discordGuildId: number, knoveraIdentity: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM discord_guild_authorizations WHERE discord_guild_id = $1 AND knovera_identity = $2`, [
    discordGuildId,
    knoveraIdentity,
  ]);
  return result.rowCount !== null && result.rowCount > 0;
}

/** Every discord_guilds.id this identity is authorized for — used to filter the connected-guilds list down to only what THIS identity may see (spec: never every guild the deployment bot happens to be installed in). */
export async function listAuthorizedDiscordGuildIds(pool: Pool, knoveraIdentity: string): Promise<number[]> {
  const result = await pool.query<{ discord_guild_id: string }>(`SELECT discord_guild_id FROM discord_guild_authorizations WHERE knovera_identity = $1`, [knoveraIdentity]);
  return result.rows.map((r) => Number(r.discord_guild_id));
}

/** How many identities (including this one) currently hold an authorization for this guild — used by disconnect to decide whether the underlying bot installation should actually leave the guild (only once the LAST authorized identity revokes — see discordConnections.ts's disconnect handler doc comment) or merely stop being usable by the identity that just revoked. */
export async function countDiscordGuildAuthorizations(pool: Pool, discordGuildId: number): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM discord_guild_authorizations WHERE discord_guild_id = $1`, [discordGuildId]);
  return Number(result.rows[0].count);
}

/** Revokes exactly this identity's grant — never any other identity's, even for the same guild (a shared guild's other authorized identities are untouched). */
export async function revokeDiscordGuildAuthorization(pool: Pool, discordGuildId: number, knoveraIdentity: string): Promise<void> {
  await pool.query(`DELETE FROM discord_guild_authorizations WHERE discord_guild_id = $1 AND knovera_identity = $2`, [discordGuildId, knoveraIdentity]);
}
