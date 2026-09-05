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
 * Returns a Whop access token guaranteed fresh for immediate use, refreshing
 * the stored session first if it's near expiry. If the session is missing
 * or a refresh attempt itself fails, marks the session AUTH_REQUIRED (never
 * invented — Whop's documented refresh_token grant is the only mechanism
 * used) and throws {@link AuthRequiredError} rather than proceeding.
 */
export async function getValidAccessToken(
  pool: Pool,
  oauthClient: WhopOAuthClient,
  encryptionKey: string,
): Promise<string> {
  const session = await getAuthSession(pool, encryptionKey);
  if (!session) {
    throw new AuthRequiredError("No Whop session has been established yet.");
  }
  if (session.status === "auth_required") {
    throw new AuthRequiredError("Whop authorization expired — please reconnect.");
  }

  const msUntilExpiry = session.accessTokenExpiresAt.getTime() - Date.now();
  if (session.accessToken && msUntilExpiry > REFRESH_MARGIN_MS) {
    return session.accessToken;
  }

  try {
    const refreshed = await oauthClient.refreshAccessToken(session.refreshToken);
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await updateAccessToken(
      pool,
      refreshed.access_token,
      expiresAt,
      encryptionKey,
      refreshed.refresh_token ?? null,
    );
    return refreshed.access_token;
  } catch (err) {
    if (err instanceof WhopRefreshError) {
      await markAuthRequired(pool);
      throw new AuthRequiredError("Whop session refresh failed — please reconnect.");
    }
    throw err;
  }
}
