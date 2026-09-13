/**
 * Stashes a Discord account-link token across the login redirect, mirroring
 * sessionConfig.ts's existing pattern for the Whop OAuth round trip: a
 * "Save to Knovera" link opened while signed out of Knovera must not lose
 * its one-time token just because the operator has to log in first (see
 * LinkDiscordPage.tsx and App.tsx's handleKnoveraLogin).
 */
const PENDING_TOKEN_KEY = "knovera_pending_discord_link_token";

export function savePendingDiscordLinkToken(token: string): void {
  sessionStorage.setItem(PENDING_TOKEN_KEY, token);
}

/** Reads and clears the stashed token in one step — it is single-use by construction (see discordLinkTokensRepo.ts server-side), so nothing is served by keeping a second copy around after this is read. */
export function takePendingDiscordLinkToken(): string | null {
  const token = sessionStorage.getItem(PENDING_TOKEN_KEY);
  if (token) sessionStorage.removeItem(PENDING_TOKEN_KEY);
  return token;
}
