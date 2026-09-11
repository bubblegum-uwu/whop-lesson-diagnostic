export class YouTubeChannelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeChannelDiscoveryError";
  }
}

export interface DiscoveredYouTubeVideo {
  videoId: string;
  title: string;
  /** ISO 8601 — null if the feed omitted it (never fabricated). */
  publishedAt: string | null;
  sourceUrl: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Discovers a YouTube channel's videos via YouTube's own OFFICIAL,
 * documented, unauthenticated Atom feed
 * (`https://www.youtube.com/feeds/videos.xml?channel_id=...`) — never
 * scraping rendered channel-page HTML (see the Phase 4K PR description's
 * "why RSS, not scraping or the Data API" section). No API key, no
 * credentials, no new configuration required.
 *
 * HONEST LIMITATION, by design of the feed itself: this returns only the
 * channel's ~15 MOST RECENT uploads, never the channel's full history —
 * there is no pagination mechanism in this feed. A channel with more than
 * ~15 videos will only ever have its newest ones discovered through this
 * path; older uploads are out of scope for Phase 4K's collection
 * discovery and would need the YouTube Data API (which requires a
 * provisioned, quota-managed API key this deployment does not currently
 * configure) to reach. This is surfaced to the caller/UI, never silently
 * hidden.
 *
 * Discovery only: gathers metadata to create/list catalog items, never
 * downloads or analyzes a video (Phase 4K spec section 16) — same bounded
 * -fetch shape as resolveYoutubeChannel.ts / discord/downloadDiscordAttachment.ts.
 */
export async function discoverYoutubeChannelVideos(channelId: string): Promise<{ videos: DiscoveredYouTubeVideo[]; channelTitle: string }> {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(feedUrl, { signal: controller.signal, headers: { Accept: "application/atom+xml" } });
  } catch (err) {
    throw new YouTubeChannelDiscoveryError(
      `Could not reach YouTube to discover this channel's videos (${err instanceof Error ? err.name : "network error"}).`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (res.status === 404) {
    throw new YouTubeChannelDiscoveryError("No YouTube channel exists with this ID.");
  }
  if (!res.ok) {
    throw new YouTubeChannelDiscoveryError(`Could not discover this channel's videos (HTTP ${res.status}).`);
  }
  if (!res.body) {
    throw new YouTubeChannelDiscoveryError("YouTube returned an empty response while discovering this channel's videos.");
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
      throw new YouTubeChannelDiscoveryError("YouTube's video feed for this channel was unexpectedly large.");
    }
    chunks.push(Buffer.from(value));
  }
  const xml = Buffer.concat(chunks).toString("utf-8");

  const channelTitleMatch = xml.match(/<title>([^<]*)<\/title>/);
  const channelTitle = channelTitleMatch ? decodeXmlEntities(channelTitleMatch[1]) : "YouTube Channel";

  const videos: DiscoveredYouTubeVideo[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch: RegExpExecArray | null;
  while ((entryMatch = entryPattern.exec(xml)) !== null) {
    const entry = entryMatch[1];
    const videoIdMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    const titleMatch = entry.match(/<title>([^<]*)<\/title>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    if (!videoIdMatch || !titleMatch) continue;
    const videoId = videoIdMatch[1];
    videos.push({
      videoId,
      title: decodeXmlEntities(titleMatch[1]),
      publishedAt: publishedMatch ? publishedMatch[1] : null,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return { videos, channelTitle };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
