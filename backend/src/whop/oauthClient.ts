/**
 * Server-side counterpart to the frontend's PKCE authorize/exchange flow
 * (src/oauth/whopOAuth.ts): the documented refresh_token grant, revoke
 * call, and identity verification, used to keep a stored session alive
 * without the user re-authorizing every hour, and to prove who a bearer
 * token actually belongs to.
 *
 *   Refresh:  POST https://api.whop.com/oauth/token    {grant_type: "refresh_token", refresh_token, client_id}
 *   Revoke:   POST https://api.whop.com/oauth/revoke   {token, client_id}
 *   Identity: GET  https://api.whop.com/oauth/userinfo Authorization: Bearer <token>
 *
 * No client_secret is ever sent — this stays the same public PKCE client
 * the frontend already uses.
 *
 * `verifyAccessToken` is the ONLY source of truth for "who does this token
 * belong to" anywhere in this backend. Nothing authorizes based on a
 * client-supplied id_token payload, Origin header, or client_id.
 */

export const WHOP_TOKEN_URL = "https://api.whop.com/oauth/token";
export const WHOP_REVOKE_URL = "https://api.whop.com/oauth/revoke";
export const WHOP_USERINFO_URL = "https://api.whop.com/oauth/userinfo";

export interface RefreshedTokens {
  access_token: string;
  /** Present only if Whop rotated the refresh token; callers must persist it if so. */
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface WhopUserInfo {
  /** The verified Whop user identifier (e.g. "user_xxxxx") — the operator identity. */
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
}

export class WhopRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopRefreshError";
  }
}

export class WhopIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopIdentityError";
  }
}

export interface WhopOAuthClient {
  refreshAccessToken(refreshToken: string): Promise<RefreshedTokens>;
  revokeRefreshToken(refreshToken: string): Promise<void>;
  verifyAccessToken(accessToken: string): Promise<WhopUserInfo>;
}

export function createWhopOAuthClient(clientId: string): WhopOAuthClient {
  async function refreshAccessToken(refreshToken: string): Promise<RefreshedTokens> {
    const res = await fetch(WHOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });

    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      throw new WhopRefreshError(
        `Whop token refresh failed (${res.status}): ${err.error_description || err.error || "unknown error"}`,
      );
    }

    return (await res.json()) as RefreshedTokens;
  }

  async function revokeRefreshToken(refreshToken: string): Promise<void> {
    const res = await fetch(WHOP_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: refreshToken, client_id: clientId }),
    });
    // Revocation is best-effort from the caller's point of view: whether or
    // not Whop's revoke succeeds, the local session row is deleted
    // immediately after this call by the route handler. We only log/surface
    // a non-2xx here, never throw and block the local disconnect on it.
    if (!res.ok) {
      throw new WhopRefreshError(`Whop token revoke returned ${res.status}`);
    }
  }

  async function verifyAccessToken(accessToken: string): Promise<WhopUserInfo> {
    const res = await fetch(WHOP_USERINFO_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new WhopIdentityError(`Whop userinfo verification failed (${res.status}).`);
    }
    const body = (await res.json().catch(() => ({}))) as Partial<WhopUserInfo>;
    if (typeof body.sub !== "string" || body.sub.length === 0) {
      throw new WhopIdentityError("Whop userinfo response did not include a sub claim.");
    }
    return body as WhopUserInfo;
  }

  return { refreshAccessToken, revokeRefreshToken, verifyAccessToken };
}
