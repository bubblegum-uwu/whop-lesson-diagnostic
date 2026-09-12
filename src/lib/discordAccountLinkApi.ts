/**
 * Client for the Discord account-linking endpoints (Phase 4K-B revised) —
 * GET/POST/DELETE /api/discord/link. All three require a Knovera session
 * (never a Whop token) — see backend/src/http/routes/discordAccountLink.ts.
 * Linking itself is driven by a one-time token minted by the "Save to
 * Knovera" Discord interaction (see LinkDiscordPage.tsx), never a Discord
 * user id typed or supplied by this browser.
 */
function authHeaders(knoveraToken: string): HeadersInit {
  return { Authorization: `Bearer ${knoveraToken}` };
}

export class DiscordLinkApiError extends Error {
  type: string;
  constructor(message: string, type: string) {
    super(message);
    this.name = "DiscordLinkApiError";
    this.type = type;
  }
}

async function throwOnError(res: Response, fallback: string): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => undefined);
  throw new DiscordLinkApiError(body?.error?.message ?? fallback, body?.error?.type ?? "unknown_error");
}

export interface DiscordLinkStatus {
  linked: boolean;
  discordUserIds: string[];
}

/** GET /api/discord/link */
export async function getDiscordLinkStatus(backendUrl: string, knoveraToken: string): Promise<DiscordLinkStatus> {
  const res = await fetch(`${backendUrl}/api/discord/link`, { headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to load Discord link status (${res.status}).`);
  return (await res.json()) as DiscordLinkStatus;
}

/**
 * POST /api/discord/link — consumes the one-time token from the "Save to
 * Knovera" interaction's ephemeral reply, linking that Discord user to
 * whichever Knovera identity this (already-authenticated) browser session
 * belongs to. Throws DiscordLinkApiError (type "invalid_link_token") for
 * an expired/replayed/unknown token.
 */
export async function consumeDiscordLinkToken(backendUrl: string, knoveraToken: string, token: string): Promise<void> {
  const res = await fetch(`${backendUrl}/api/discord/link`, {
    method: "POST",
    headers: { ...authHeaders(knoveraToken), "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await throwOnError(res, `Failed to link your Discord account (${res.status}).`);
}

/** DELETE /api/discord/link — affects future captures only; never touches anything already captured (see the backend route's own doc comment). */
export async function unlinkDiscord(backendUrl: string, knoveraToken: string): Promise<void> {
  const res = await fetch(`${backendUrl}/api/discord/link`, { method: "DELETE", headers: authHeaders(knoveraToken) });
  await throwOnError(res, `Failed to unlink Discord (${res.status}).`);
}
