/**
 * Whop OAuth 2.1 + PKCE client flow.
 *
 * Documented endpoints (https://docs.whop.com/developer/guides/oauth):
 *   Authorize: https://api.whop.com/oauth/authorize
 *   Token:     https://api.whop.com/oauth/token
 *
 * This diagnostic app is a PKCE public client: it never has and never
 * requests a client_secret. Only `client_id` (not a secret) is used.
 *
 * Requested scopes for this proof-of-concept: openid profile courses:read
 */
import { createAndStorePkceState, consumeStoredPkceState, sha256Base64Url } from "./pkce";

export const WHOP_AUTHORIZE_URL = "https://api.whop.com/oauth/authorize";
export const WHOP_TOKEN_URL = "https://api.whop.com/oauth/token";

export const REQUESTED_SCOPES = "openid profile courses:read";

/** Tokens as returned by Whop's token endpoint. Never logged, never persisted beyond memory/session. */
export interface WhopTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}

export class WhopOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopOAuthError";
  }
}

/**
 * Builds the authorize URL and redirects the browser to Whop for
 * user sign-in and consent. Generates and stores a fresh PKCE
 * verifier/state/nonce in sessionStorage first.
 */
export async function startWhopOAuth(
  clientId: string,
  redirectUri: string,
  scope: string = REQUESTED_SCOPES,
): Promise<string> {
  const pkce = createAndStorePkceState();
  const codeChallenge = await sha256Base64Url(pkce.codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: pkce.state,
    nonce: pkce.nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `${WHOP_AUTHORIZE_URL}?${params.toString()}`;
}

export interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export function parseCallbackParams(search: string): CallbackParams {
  const params = new URLSearchParams(search);
  return {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
    errorDescription: params.get("error_description"),
  };
}

/**
 * Validates the OAuth callback (state check against the stored PKCE state)
 * and exchanges the authorization code for tokens.
 *
 * No client_secret is ever sent — this is a public PKCE client.
 */
export async function exchangeCodeForTokens(
  clientId: string,
  redirectUri: string,
  callback: CallbackParams,
): Promise<WhopTokens> {
  if (callback.error) {
    throw new WhopOAuthError(
      `OAuth error: ${callback.error} - ${callback.errorDescription ?? ""}`,
    );
  }

  const stored = consumeStoredPkceState();
  if (!stored) {
    throw new WhopOAuthError(
      "No PKCE state found for this session. Please restart the sign-in flow.",
    );
  }

  if (!callback.state || callback.state !== stored.state) {
    throw new WhopOAuthError("Invalid state parameter - possible CSRF. Please retry.");
  }

  if (!callback.code) {
    throw new WhopOAuthError("No authorization code was returned by Whop.");
  }

  const res = await fetch(WHOP_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: stored.codeVerifier,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new WhopOAuthError(
      `Token exchange failed: ${err.error_description || err.error || res.status}`,
    );
  }

  return (await res.json()) as WhopTokens;
}
