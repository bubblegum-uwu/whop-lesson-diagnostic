import type { Pool, PoolClient } from "pg";
import { encryptSecret, decryptSecret } from "../lib/crypto.js";

/**
 * Every function here accepts either a plain `Pool` or a `PoolClient`
 * checked out inside a transaction — the latter is what the refresh
 * single-flight lock in whop/sessionService.ts uses, so its
 * check-then-maybe-refresh sequence runs on one connection under one
 * `pg_advisory_xact_lock`.
 */
export type Queryable = Pool | PoolClient;

export type AuthSessionStatus = "active" | "auth_required";

export interface AuthSession {
  whopUserId: string | null;
  accessToken: string | null;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  status: AuthSessionStatus;
}

export interface SaveAuthSessionInput {
  whopUserId: string | null;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
}

/** There is exactly one session row today (single-operator system — see migration comment). */
const SESSION_ID = 1;

export async function saveAuthSession(
  db: Queryable,
  input: SaveAuthSessionInput,
  encryptionKey: string,
): Promise<void> {
  const encryptedAccessToken = encryptSecret(input.accessToken, encryptionKey);
  const encryptedRefreshToken = encryptSecret(input.refreshToken, encryptionKey);

  await db.query(
    `INSERT INTO auth_sessions (
       id, whop_user_id, encrypted_access_token, encrypted_refresh_token,
       access_token_expires_at, status
     ) VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (id) DO UPDATE SET
       whop_user_id = EXCLUDED.whop_user_id,
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       status = 'active',
       updated_at = now()`,
    [SESSION_ID, input.whopUserId, encryptedAccessToken, encryptedRefreshToken, input.accessTokenExpiresAt],
  );
}

export async function getAuthSession(db: Queryable, encryptionKey: string): Promise<AuthSession | null> {
  const result = await db.query(
    `SELECT whop_user_id, encrypted_access_token, encrypted_refresh_token,
            access_token_expires_at, status
     FROM auth_sessions WHERE id = $1`,
    [SESSION_ID],
  );
  const row = result.rows[0] as
    | {
        whop_user_id: string | null;
        encrypted_access_token: Buffer | null;
        encrypted_refresh_token: Buffer;
        access_token_expires_at: Date;
        status: AuthSessionStatus;
      }
    | undefined;
  if (!row) return null;

  return {
    whopUserId: row.whop_user_id,
    accessToken: row.encrypted_access_token ? decryptSecret(row.encrypted_access_token, encryptionKey) : null,
    refreshToken: decryptSecret(row.encrypted_refresh_token, encryptionKey),
    accessTokenExpiresAt: row.access_token_expires_at,
    status: row.status,
  };
}

export interface AuthSessionStatusView {
  whopUserId: string | null;
  status: AuthSessionStatus;
  accessTokenExpiresAt: Date;
}

/** Status-only read — never touches the encrypted columns, so no decryption/key needed. */
export async function getAuthSessionStatus(db: Queryable): Promise<AuthSessionStatusView | null> {
  const result = await db.query(
    `SELECT whop_user_id, status, access_token_expires_at FROM auth_sessions WHERE id = $1`,
    [SESSION_ID],
  );
  const row = result.rows[0] as
    | { whop_user_id: string | null; status: AuthSessionStatus; access_token_expires_at: Date }
    | undefined;
  if (!row) return null;
  return { whopUserId: row.whop_user_id, status: row.status, accessTokenExpiresAt: row.access_token_expires_at };
}

/** Marks the session AUTH_REQUIRED — e.g. a refresh attempt itself failed. Never deletes the row. */
export async function markAuthRequired(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE auth_sessions SET status = 'auth_required', updated_at = now() WHERE id = $1`,
    [SESSION_ID],
  );
}

/** Updates just the access token + expiry after a successful refresh, leaving the refresh token as-is unless Whop rotated it. */
export async function updateAccessToken(
  db: Queryable,
  accessToken: string,
  accessTokenExpiresAt: Date,
  encryptionKey: string,
  newRefreshToken: string | null,
): Promise<void> {
  const encryptedAccessToken = encryptSecret(accessToken, encryptionKey);
  if (newRefreshToken) {
    const encryptedRefreshToken = encryptSecret(newRefreshToken, encryptionKey);
    await db.query(
      `UPDATE auth_sessions SET
         encrypted_access_token = $2, encrypted_refresh_token = $3,
         access_token_expires_at = $4, status = 'active', updated_at = now()
       WHERE id = $1`,
      [SESSION_ID, encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt],
    );
  } else {
    await db.query(
      `UPDATE auth_sessions SET
         encrypted_access_token = $2, access_token_expires_at = $3, status = 'active', updated_at = now()
       WHERE id = $1`,
      [SESSION_ID, encryptedAccessToken, accessTokenExpiresAt],
    );
  }
}

/** Explicit disconnect: the caller is responsible for calling Whop's revoke endpoint first. */
export async function deleteAuthSession(db: Queryable): Promise<void> {
  await db.query(`DELETE FROM auth_sessions WHERE id = $1`, [SESSION_ID]);
}
