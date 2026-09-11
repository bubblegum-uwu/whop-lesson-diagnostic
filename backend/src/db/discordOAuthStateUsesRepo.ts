import type { Pool } from "pg";

/**
 * Phase 4K-B review fix — single-use enforcement for the signed Discord
 * connect-state JWT (lib/discordOAuthState.ts), keyed by its own `jti`.
 * See the 1790100000000_discord-guild-authorizations.sql migration's doc
 * comment: one INSERT, unique-violation means "already used."
 */

/** Returns true the FIRST time a given jti is marked used (this callback may proceed); false every time after (a replay — reject exactly like an invalid/expired state). */
export async function markDiscordOAuthStateUsed(pool: Pool, jti: string): Promise<boolean> {
  const result = await pool.query(`INSERT INTO discord_oauth_state_uses (jti) VALUES ($1) ON CONFLICT (jti) DO NOTHING`, [jti]);
  return result.rowCount !== null && result.rowCount > 0;
}
