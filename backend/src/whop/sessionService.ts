import type { Pool } from "pg";
import {
  getAuthSession,
  updateAccessToken,
  markAuthRequired,
} from "../db/authSessionRepo.js";
import { WhopRefreshError, type WhopOAuthClient } from "./oauthClient.js";

/** No usable Whop session exists (never connected, or a refresh attempt failed). */
export class AuthRequiredError extends Error {
  constructor(message = "Whop authorization is required.") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** Refresh proactively once less than this much time remains, never reactively mid-batch. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Arbitrary, stable key for the Postgres advisory lock guarding the
 * refresh critical section below. Whop rotates refresh tokens, so two
 * concurrent processes (this API service today; the API + a PR2 worker
 * later) must never both read the same refresh token and both attempt to
 * spend it — the second would fail against a token Whop already
 * invalidated, or worse, clobber the first's successful rotation.
 */
const REFRESH_LOCK_KEY = 822_154_001;

/**
 * Returns a Whop access token guaranteed fresh for immediate use, refreshing
 * the stored session first if it's near expiry. If the session is missing
 * or a refresh attempt itself fails, marks the session AUTH_REQUIRED (never
 * invented — Whop's documented refresh_token grant is the only mechanism
 * used) and throws {@link AuthRequiredError} rather than proceeding.
 *
 * The whole check-and-maybe-refresh sequence runs inside one Postgres
 * transaction holding `pg_advisory_xact_lock(REFRESH_LOCK_KEY)`: a second
 * concurrent caller blocks until the first commits, then re-reads the row
 * (now already refreshed, under READ COMMITTED) instead of racing Whop's
 * refresh grant with the same soon-to-be-rotated token.
 */
export async function getValidAccessToken(
  pool: Pool,
  oauthClient: WhopOAuthClient,
  encryptionKey: string,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [REFRESH_LOCK_KEY]);

    const session = await getAuthSession(client, encryptionKey);
    if (!session) {
      await client.query("ROLLBACK");
      throw new AuthRequiredError("No Whop session has been established yet.");
    }
    if (session.status === "auth_required") {
      await client.query("ROLLBACK");
      throw new AuthRequiredError("Whop authorization expired — please reconnect.");
    }

    const msUntilExpiry = session.accessTokenExpiresAt.getTime() - Date.now();
    if (session.accessToken && msUntilExpiry > REFRESH_MARGIN_MS) {
      await client.query("COMMIT");
      return session.accessToken;
    }

    try {
      const refreshed = await oauthClient.refreshAccessToken(session.refreshToken);
      const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
      await updateAccessToken(
        client,
        refreshed.access_token,
        expiresAt,
        encryptionKey,
        refreshed.refresh_token ?? null,
      );
      await client.query("COMMIT");
      return refreshed.access_token;
    } catch (err) {
      if (err instanceof WhopRefreshError) {
        await markAuthRequired(client);
        await client.query("COMMIT");
        throw new AuthRequiredError("Whop session refresh failed — please reconnect.");
      }
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}
