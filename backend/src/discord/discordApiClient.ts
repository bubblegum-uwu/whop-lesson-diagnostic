/**
 * Phase 4K-B — the smallest-necessary client for the documented Discord
 * REST API v10 endpoints authenticated collection discovery needs. Plain
 * `fetch`, not a Discord SDK (e.g. discord.js) — discord.js is a full
 * gateway/bot framework built around a persistent WebSocket connection and
 * event-driven command handling; this backend only ever needs a handful of
 * bounded, one-shot REST calls (list guilds, list channels, page message
 * history), so pulling in a stateful gateway client would be the wrong
 * shape entirely. No new dependency was added.
 *
 * Every call here authenticates with `Authorization: Bot <token>` — the
 * single, static, deployment-wide bot token (config.discordBotToken).
 * Deliberately NOT a per-user/per-guild OAuth access token: a user's own
 * OAuth token (scope `identify`/`guilds`) can only ever prove "which
 * guilds is this Discord user a member of" and cannot read channel
 * contents or message history — Discord's permission model requires the
 * BOT to be a member of the guild (added via the bot-install authorize
 * flow — http/routes/discordConnections.ts) with the relevant per-channel
 * permissions, and only a bot token can then read on the bot's own behalf.
 * See config.ts's discordBotToken doc comment for the fuller "why".
 */

const DISCORD_API_BASE = "https://discord.com/api/v10";
const FETCH_TIMEOUT_MS = 10_000;
// Guild/channel/message-page JSON responses are small — well under 2MB
// even for a full 100-message page with attachments. Safety bound against
// a misbehaving/oversized response, matching every other bounded-fetch
// client in this codebase (youtube/youtubeDataApiClient.ts, discord/downloadDiscordAttachment.ts).
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Discord's documented rate-limit response — a single bounded retry, never
// an unbounded backoff loop that could hang an HTTP request indefinitely.
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

export class DiscordApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordApiError";
  }
}
export class DiscordApiForbiddenError extends DiscordApiError {}
export class DiscordApiUnauthorizedError extends DiscordApiError {}
export class DiscordApiRateLimitedError extends DiscordApiError {}
export class DiscordApiNotFoundError extends DiscordApiError {}

async function discordFetch<T>(path: string, botToken: string, params: Record<string, string> = {}, attempt = 0): Promise<T> {
  const url = new URL(`${DISCORD_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal, headers: { Authorization: `Bot ${botToken}`, Accept: "application/json" } });
  } catch (err) {
    throw new DiscordApiError(`Could not reach the Discord API (${err instanceof Error ? err.name : "network error"}).`);
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 429 && attempt === 0) {
    const body = (await res.json().catch(() => undefined)) as { retry_after?: number } | undefined;
    const headerRetry = Number(res.headers.get("retry-after"));
    const retryAfterMs = Math.min((body?.retry_after ?? headerRetry ?? 1) * 1000, MAX_RATE_LIMIT_WAIT_MS);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return discordFetch<T>(path, botToken, params, attempt + 1);
  }
  if (res.status === 429) {
    throw new DiscordApiRateLimitedError("Discord API rate limit exceeded — please try again shortly.");
  }
  if (res.status === 401) {
    throw new DiscordApiUnauthorizedError("Discord rejected this request — the bot token may be invalid.");
  }
  if (res.status === 403) {
    throw new DiscordApiForbiddenError("Discord denied access — the bot may lack permission for this guild/channel.");
  }
  if (res.status === 404) {
    throw new DiscordApiNotFoundError("Discord returned not found — the bot may have been removed from this guild.");
  }

  if (!res.body) throw new DiscordApiError("Discord API returned an empty response.");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DiscordApiError("Discord API response was unexpectedly large.");
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new DiscordApiError("Discord API returned a response that could not be parsed.");
  }
  if (!res.ok) {
    const message = (json as { message?: unknown } | undefined)?.message;
    throw new DiscordApiError(typeof message === "string" ? `Discord API error: ${message}` : `Discord API error (HTTP ${res.status}).`);
  }
  return json as T;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
}

/** GET /users/@me/guilds — every guild the BOT is currently a member of. This is the actual authorization boundary: a guild can never appear here unless someone with Manage Server permission on it explicitly added the bot via the install flow (spec section 6/11 — never inferred from a typed guild id, never "all accessible guilds silently mirrored"). */
export async function listBotGuilds(botToken: string): Promise<DiscordGuildSummary[]> {
  const guilds = await discordFetch<Array<{ id: string; name: string }>>("/users/@me/guilds", botToken);
  return guilds.map((g) => ({ id: g.id, name: g.name }));
}

export async function getGuild(guildId: string, botToken: string): Promise<DiscordGuildSummary> {
  const guild = await discordFetch<{ id: string; name: string }>(`/guilds/${encodeURIComponent(guildId)}`, botToken);
  return { id: guild.id, name: guild.name };
}

// Discord channel types this integration can ever read message history
// from — https://discord.com/developers/docs/resources/channel#channel-object-channel-types.
// 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT. Voice (2), category (4), forum
// (15), and other types are surfaced but marked unsupported rather than
// silently treated as fully readable (spec section 12).
const TEXT_CAPABLE_CHANNEL_TYPES = new Set([0, 5]);

export interface DiscordChannelSummary {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  textCapable: boolean;
}

/** GET /guilds/{id}/channels — every channel in the guild, with textCapable marking which types this integration could ever read (voice/category/etc. are never presented as importable). Does NOT itself confirm the bot can actually READ a text-capable channel's history — see probeChannelReadable, a separate, explicit check (computing Discord's full permission-overwrite algorithm here would be substantial extra complexity for a signal `probeChannelReadable` gets more simply and more authoritatively, straight from the API). */
export async function listGuildChannels(guildId: string, botToken: string): Promise<DiscordChannelSummary[]> {
  const channels = await discordFetch<Array<{ id: string; name: string; type: number; parent_id: string | null }>>(`/guilds/${encodeURIComponent(guildId)}/channels`, botToken);
  return channels.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id, textCapable: TEXT_CAPABLE_CHANNEL_TYPES.has(c.type) }));
}

/** A single bounded, real request (limit=1) to authoritatively answer "can the bot currently read this channel's message history" — a 403 here means no, cleanly, without hand-rolling Discord's role/overwrite permission computation. */
export async function probeChannelReadable(channelId: string, botToken: string): Promise<boolean> {
  try {
    await discordFetch(`/channels/${encodeURIComponent(channelId)}/messages`, botToken, { limit: "1" });
    return true;
  } catch (err) {
    if (err instanceof DiscordApiForbiddenError) return false;
    throw err;
  }
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  contentType: string | null;
  size: number;
}
export interface DiscordMessagePage {
  attachments: Array<{ messageId: string; attachment: DiscordAttachment }>;
  /** The oldest message id seen in this page — pass as `before` to continue deeper into history; undefined when the page was empty (no more history). */
  oldestMessageId: string | undefined;
}

const MESSAGES_PAGE_SIZE = 50;

/** GET /channels/{id}/messages — ONE page (up to 50), walking backward (newest-to-oldest, Discord's own default order) from `before` if given. Metadata only: attachment id/filename/url/contentType/size, never message content/text (spec section 15 — this integration never promises analysis of arbitrary message text). */
export async function listChannelMessagesPage(channelId: string, botToken: string, before?: string): Promise<DiscordMessagePage> {
  const messages = await discordFetch<Array<{ id: string; attachments: Array<{ id: string; filename: string; url: string; content_type?: string; size: number }> }>>(
    `/channels/${encodeURIComponent(channelId)}/messages`,
    botToken,
    { limit: String(MESSAGES_PAGE_SIZE), ...(before ? { before } : {}) },
  );
  const attachments: Array<{ messageId: string; attachment: DiscordAttachment }> = [];
  for (const message of messages) {
    for (const a of message.attachments ?? []) {
      attachments.push({ messageId: message.id, attachment: { id: a.id, filename: a.filename, url: a.url, contentType: a.content_type ?? null, size: a.size } });
    }
  }
  const oldestMessageId = messages.length > 0 ? messages[messages.length - 1].id : undefined;
  return { attachments, oldestMessageId };
}

/** DELETE /users/@me/guilds/{id} — best-effort: the bot leaves the guild on disconnect (spec section 26). Never throws; a caller that wants to know about failure should catch inside discordFetch's errors itself if it matters — here disconnect always proceeds locally regardless. */
export async function leaveGuild(guildId: string, botToken: string): Promise<void> {
  const url = new URL(`${DISCORD_API_BASE}/users/@me/guilds/${encodeURIComponent(guildId)}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(url.toString(), { method: "DELETE", signal: controller.signal, headers: { Authorization: `Bot ${botToken}` } });
  } catch {
    // Best-effort — see doc comment.
  } finally {
    clearTimeout(timeout);
  }
}
