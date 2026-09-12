import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";

/**
 * Phase 4K-B (revised) — the one-time Discord-account-linking token (spec
 * section 12/13). The plaintext token is handed to the Discord user
 * exactly once, in the interaction's ephemeral response; only its SHA-256
 * hash is ever persisted (spec section 13: "prefer storing a token hash
 * rather than plaintext"). SHA-256 (not a slow password hash like scrypt)
 * is the correct primitive here — this is a high-entropy, single-use,
 * short-lived random token, not a human-memorable password subject to
 * offline guessing; the security property needed is "can't be reversed
 * from the stored hash," which a fast cryptographic hash already
 * provides. Generated via node:crypto's own CSPRNG (randomBytes) — no
 * hand-rolled randomness.
 */

const TOKEN_BYTES = 32; // 256 bits of entropy
export const DISCORD_LINK_TOKEN_TTL_SECONDS = 10 * 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a fresh plaintext token (returned ONCE, never persisted) and its hash (persisted, bound to discordUserId + an expiry). */
export async function issueDiscordLinkToken(pool: Pool, discordUserId: string, ttlSeconds: number = DISCORD_LINK_TOKEN_TTL_SECONDS): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await pool.query(`INSERT INTO discord_link_tokens (token_hash, discord_user_id, expires_at) VALUES ($1, $2, $3)`, [hashToken(token), discordUserId, expiresAt]);
  return token;
}

/**
 * Atomically consumes a token: valid (exists, unexpired, not already
 * consumed) AND single-use in the SAME statement — a concurrent or
 * replayed second consume attempt for the same token matches zero rows,
 * exactly like the Discord OAuth connect-state single-use guard (spec
 * section 13: "reject ... replayed token"). Returns the bound
 * discordUserId on success, null on any failure — a single generic
 * outcome, never distinguishing "expired" from "already used" from
 * "never existed" to the caller.
 */
export async function consumeDiscordLinkToken(pool: Pool, token: string): Promise<string | null> {
  const result = await pool.query<{ discord_user_id: string }>(
    `UPDATE discord_link_tokens SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING discord_user_id`,
    [hashToken(token)],
  );
  return result.rows[0]?.discord_user_id ?? null;
}
