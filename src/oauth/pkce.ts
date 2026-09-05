/**
 * PKCE (Proof Key for Code Exchange) helpers for the Whop OAuth 2.1 flow.
 *
 * Follows the implementation documented at:
 * https://docs.whop.com/developer/guides/oauth
 *
 * The verifier/state/nonce are stored ONLY in sessionStorage (cleared when
 * the browser tab/session ends), never persisted, never logged.
 */

const STORAGE_KEY = "whop_oauth_pkce";

export interface PkceState {
  codeVerifier: string;
  state: string;
  nonce: string;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}

export function randomString(len: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(len)));
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64url(new Uint8Array(digest));
}

/** Generates a fresh PKCE verifier/state/nonce triple and stores it in sessionStorage. */
export function createAndStorePkceState(): PkceState {
  const pkce: PkceState = {
    codeVerifier: randomString(32),
    state: randomString(16),
    nonce: randomString(16),
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pkce));
  return pkce;
}

/** Reads and clears the stored PKCE state (single use, session-only). */
export function consumeStoredPkceState(): PkceState | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkceState;
  } catch {
    return null;
  }
}

export function clearStoredPkceState(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
