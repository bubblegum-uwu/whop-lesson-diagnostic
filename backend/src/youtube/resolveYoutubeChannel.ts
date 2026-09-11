import type { ParsedYouTubeChannelRef } from "../lib/youtubeChannelUrl.js";

export class YouTubeChannelResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeChannelResolveError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;
// A channel "about" page is a small HTML document — well under 2MB even
// with YouTube's heavy inline bundle; this is a safety bound against a
// misbehaving/oversized response, not an expected-to-bind limit.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Resolves a "handle"-form channel reference (an @handle, /c/CustomName,
 * or /user/LegacyName — see youtubeChannelUrl.ts) to YouTube's own stable
 * "UCxxxx..." channel id, via ONE bounded fetch of the channel's own page
 * and a read of its own declared canonical link
 * (`<link rel="canonical" href="https://www.youtube.com/channel/UC...">`)
 * — a standard, stable piece of metadata essentially every channel page
 * declares, not a parse of rendered video-list content. This is identity
 * resolution only ("which channel is this handle?"), never content
 * discovery ("what videos does this channel have?" — see
 * discoverYoutubeChannelVideos.ts, which uses the official RSS feed and
 * never touches this function).
 *
 * Same bounded-fetch shape as discord/downloadDiscordAttachment.ts
 * (AbortController timeout + a byte ceiling enforced while streaming) —
 * this is metadata-sized, so both bounds are far smaller.
 */
export async function resolveYouTubeChannelId(ref: ParsedYouTubeChannelRef): Promise<string> {
  if (ref.kind === "channel_id") return ref.channelId;

  const pageUrl = `https://www.youtube.com/@${encodeURIComponent(ref.handle)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(pageUrl, { signal: controller.signal, headers: { Accept: "text/html" } });
  } catch (err) {
    throw new YouTubeChannelResolveError(
      `Could not resolve this YouTube channel (${err instanceof Error ? err.name : "network error"}). Double-check the handle/URL.`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new YouTubeChannelResolveError(`Could not find a YouTube channel for "@${ref.handle}" (HTTP ${res.status}).`);
  }
  if (!res.body) {
    throw new YouTubeChannelResolveError("YouTube returned an empty response while resolving this channel.");
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
      throw new YouTubeChannelResolveError("YouTube's response while resolving this channel was unexpectedly large.");
    }
    chunks.push(Buffer.from(value));
  }
  const html = Buffer.concat(chunks).toString("utf-8");

  const match = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})">/);
  if (!match) {
    throw new YouTubeChannelResolveError(`Could not resolve "@${ref.handle}" to a YouTube channel ID — the channel may not exist.`);
  }
  return match[1];
}
