/**
 * Persists the Knovera session token client-side.
 *
 * sessionStorage, not localStorage: this is a temporary, single-operator
 * login (see the Phase 4D PR description) — the token already carries a
 * bounded 12h server-side expiry (knoveraToken.ts), and sessionStorage adds
 * a second, complementary boundary (cleared when the tab/browser closes)
 * without making the operator re-enter a password on every reload within
 * one browsing session, which the product flow explicitly wants ("If
 * already authenticated to Knovera, Enter Knovera can go directly to
 * Projects"). localStorage was deliberately avoided: it would outlive the
 * browser session indefinitely on a shared machine, which is more
 * persistence than this phase's threat model calls for. The prior Whop
 * access token was intentionally never persisted at all (in-memory only,
 * see App.tsx) — that constraint stays true for Whop; it was never
 * appropriate for what was, in effect, this app's only login credential.
 */

const STORAGE_KEY = "knovera_session_token";

export function saveKnoveraToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable (private browsing, disabled storage) — the
    // in-memory App.tsx state still works for the current page load.
  }
}

export function loadKnoveraToken(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearKnoveraToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}
