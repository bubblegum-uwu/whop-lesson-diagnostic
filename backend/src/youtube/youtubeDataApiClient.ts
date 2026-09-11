/**
 * Phase 4K — the smallest-necessary client for the two YouTube Data API v3
 * endpoints channel catalog discovery needs (`channels` and
 * `playlistItems`). Deliberately plain `fetch`, not the `googleapis` SDK —
 * two read-only GET endpoints don't justify a new dependency.
 *
 * Why the Data API at all, and why not the previous approach: see
 * discoverYoutubeChannelVideos.ts's doc comment for the full investigation
 * (RSS feed / rendered-page scraping / Data API, in that order) — the short
 * version is that YouTube's official Atom feed is capped at the channel's
 * ~15 most recent uploads with no pagination mechanism, which cannot
 * satisfy "a user may want to analyze an older video in a channel with
 * hundreds of uploads." The Data API is Google's own documented,
 * paginated, quota-managed mechanism for exactly this — it requires a
 * provisioned API key (YOUTUBE_API_KEY, see config.ts/README.md), which
 * this deployment does not ship a default for; callers must check
 * `apiKey` is present and treat its absence as a configuration error
 * (YouTubeApiNotConfiguredError below), never silently fall back to a
 * permanently-limited discovery mechanism.
 */

export class YouTubeApiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeApiRequestError";
  }
}

/** Thrown by callers (resolveYoutubeChannel.ts / discoverYoutubeChannelVideos.ts) when no YOUTUBE_API_KEY is configured — a distinct type so route handlers can return a clear "not configured" response instead of a generic upstream-failure one. */
export class YouTubeApiNotConfiguredError extends Error {
  constructor() {
    super("YouTube channel discovery requires YOUTUBE_API_KEY to be configured on this deployment — see backend/README.md's Environment variables section.");
    this.name = "YouTubeApiNotConfiguredError";
  }
}

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const FETCH_TIMEOUT_MS = 10_000;
// YouTube Data API JSON responses (channel metadata, up to 50 playlist
// items) are small — well under 2MB even for a full page; this is a safety
// bound against a misbehaving/oversized response, not an expected-to-bind
// limit. Same bounded-fetch shape as discord/downloadDiscordAttachment.ts.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Bounded GET against one YouTube Data API v3 endpoint. The API key is
 * only ever placed in the outbound request URL to Google — never included
 * in a thrown error message (so it can never leak into a log or an HTTP
 * response body).
 */
export async function fetchYouTubeDataApi<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    throw new YouTubeApiRequestError(`Could not reach the YouTube Data API (${err instanceof Error ? err.name : "network error"}).`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.body) {
    throw new YouTubeApiRequestError("YouTube Data API returned an empty response.");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new YouTubeApiRequestError("YouTube Data API response was unexpectedly large.");
    }
    chunks.push(Buffer.from(value));
  }
  const text = Buffer.concat(chunks).toString("utf-8");

  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new YouTubeApiRequestError("YouTube Data API returned a response that could not be parsed.");
  }

  if (!res.ok) {
    const apiMessage = (json as { error?: { message?: unknown } } | undefined)?.error?.message;
    throw new YouTubeApiRequestError(
      typeof apiMessage === "string" ? `YouTube Data API error: ${apiMessage}` : `YouTube Data API error (HTTP ${res.status}).`,
    );
  }
  return json as T;
}
