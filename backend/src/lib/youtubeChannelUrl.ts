/**
 * Parsing for YouTube CHANNEL identity — a NEW, separate parser from
 * youtubeUrl.ts (which parses individual VIDEO urls and explicitly REJECTS
 * every channel URL form with "Channel URLs are not supported yet"; that
 * parser and its behavior are unchanged by this file). Phase 4K.
 *
 * YouTube channels are referenced in the wild in four different forms:
 *   - youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx  (a real channel id, no resolution needed)
 *   - a bare "UCxxxxxxxxxxxxxxxxxxxxxx" id pasted directly
 *   - youtube.com/@handle                            (needs network resolution — see resolveYouTubeChannel.ts)
 *   - youtube.com/c/CustomName or /user/LegacyName    (needs network resolution — see resolveYouTubeChannel.ts)
 *
 * This is a PURE parser — it never performs a network fetch, so it is safe
 * to call before any authorization/auth check, exactly like youtubeUrl.ts's
 * own parseYouTubeVideoUrl. It only classifies the input into either an
 * already-resolved channel id, or a handle/custom-name that the caller must
 * resolve separately (a genuinely different, network-touching operation —
 * kept out of this file on purpose).
 */

export class YouTubeChannelUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeChannelUrlParseError";
  }
}

export type ParsedYouTubeChannelRef =
  | { kind: "channel_id"; channelId: string }
  | { kind: "handle"; handle: string };

// Real YouTube channel ids are always "UC" + 22 URL-safe characters (24
// chars total) — this is documented, stable YouTube channel-id shape.
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

const CHANNEL_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * Parses a YouTube channel URL or a bare channel id into a
 * ParsedYouTubeChannelRef. Handle/custom-name/legacy-username forms are
 * returned as `{ kind: "handle", handle }` (the raw path segment, without
 * the leading "@" for the handle form) — resolving that to a real channel
 * id requires a network call, done separately by resolveYouTubeChannel.ts.
 */
export function parseYouTubeChannelRef(rawInput: string): ParsedYouTubeChannelRef {
  const trimmed = typeof rawInput === "string" ? rawInput.trim() : "";
  if (trimmed.length === 0) {
    throw new YouTubeChannelUrlParseError("YouTube channel URL or ID is required.");
  }

  // A bare channel id, no URL wrapper at all.
  if (CHANNEL_ID_PATTERN.test(trimmed)) {
    return { kind: "channel_id", channelId: trimmed };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("@") ? `https://www.youtube.com/${trimmed}` : trimmed);
  } catch {
    throw new YouTubeChannelUrlParseError("Expected a youtube.com channel URL, a channel ID, or an @handle.");
  }

  if (url.protocol !== "https:") {
    throw new YouTubeChannelUrlParseError("Only https:// YouTube URLs are supported.");
  }
  const hostname = url.hostname.toLowerCase();
  if (!CHANNEL_HOSTS.has(hostname)) {
    throw new YouTubeChannelUrlParseError(`Expected a youtube.com channel URL, got hostname "${url.hostname}".`);
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length === 2 && segments[0] === "channel") {
    const channelId = segments[1];
    if (!CHANNEL_ID_PATTERN.test(channelId)) {
      throw new YouTubeChannelUrlParseError("Could not find a valid YouTube channel ID in this URL.");
    }
    return { kind: "channel_id", channelId };
  }
  if (segments.length === 1 && segments[0].startsWith("@")) {
    return { kind: "handle", handle: segments[0].slice(1) };
  }
  if (segments.length === 2 && (segments[0] === "c" || segments[0] === "user")) {
    return { kind: "handle", handle: segments[1] };
  }

  throw new YouTubeChannelUrlParseError(
    "Expected a youtube.com/channel/UC... URL, a youtube.com/@handle URL, or a bare channel ID.",
  );
}
