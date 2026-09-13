/**
 * Parsing/canonicalization for public YouTube video URLs (browser-companion
 * copy — kept in sync with backend/src/lib/youtubeUrl.ts and
 * src/lib/youtubeUrl.ts; duplicated because each is a separate npm
 * package in this PoC, mirroring lib/whopUrl.ts's existing convention).
 *
 * Used ONLY for the scanner's own same-message dedup key (see
 * discordScanner.ts) — never as the source of truth for what's a valid
 * video id or URL. The Knovera backend re-validates and re-canonicalizes
 * every URL server-side; this copy existing here does not change that.
 */

export class YouTubeUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeUrlParseError";
  }
}

export interface ParsedYouTubeVideo {
  externalId: string;
  sourceUrl: string;
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

function rejectKnownUnsupportedPath(pathname: string): void {
  if (pathname === "/playlist" || pathname.startsWith("/playlist/")) {
    throw new YouTubeUrlParseError("Playlist URLs are not supported yet — add an individual video URL.");
  }
  if (pathname.startsWith("/channel/") || pathname.startsWith("/c/") || pathname.startsWith("/user/") || pathname.startsWith("/@")) {
    throw new YouTubeUrlParseError("Channel URLs are not supported yet — add an individual video URL.");
  }
}

/**
 * Parses and validates a public YouTube video URL, returning its canonical
 * identity: a stable `externalId` (never the raw URL) and a normalized
 * `sourceUrl`. Throws YouTubeUrlParseError for anything that isn't exactly
 * one of the supported individual-video forms (`/watch?v=`, `/shorts/`,
 * `/live/`, `youtu.be/`) — tracking/query params beyond `v` are always
 * ignored, never part of the video's identity.
 */
export function parseYouTubeVideoUrl(rawUrl: string): ParsedYouTubeVideo {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new YouTubeUrlParseError("YouTube URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new YouTubeUrlParseError("The provided value is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new YouTubeUrlParseError("Only https:// YouTube URLs are supported.");
  }

  const hostname = url.hostname.toLowerCase();
  let externalId: string | null = null;

  if (WATCH_HOSTS.has(hostname)) {
    rejectKnownUnsupportedPath(url.pathname);
    if (url.pathname === "/watch") {
      externalId = url.searchParams.get("v");
    } else {
      const shortsMatch = /^\/shorts\/([^/]+)\/?$/.exec(url.pathname);
      const liveMatch = /^\/live\/([^/]+)\/?$/.exec(url.pathname);
      externalId = shortsMatch?.[1] ?? liveMatch?.[1] ?? null;
      if (externalId == null) {
        throw new YouTubeUrlParseError("Expected a youtube.com/watch?v=..., /shorts/..., or /live/... video URL.");
      }
    }
  } else if (SHORT_HOSTS.has(hostname)) {
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length !== 1) {
      throw new YouTubeUrlParseError("Expected a youtu.be/VIDEO_ID video URL.");
    }
    externalId = segments[0] ?? null;
  } else {
    throw new YouTubeUrlParseError(`Expected a youtube.com or youtu.be URL, got hostname "${url.hostname}".`);
  }

  if (!externalId || !VIDEO_ID_PATTERN.test(externalId)) {
    throw new YouTubeUrlParseError("Could not find a valid YouTube video ID in this URL.");
  }

  return { externalId, sourceUrl: `https://www.youtube.com/watch?v=${externalId}` };
}

/** Never throws — returns null for anything parseYouTubeVideoUrl would reject. Used only to compute a same-message dedup key (see discordScanner.ts); a URL that fails to canonicalize simply falls back to being keyed by its own raw string, so it's never silently dropped. */
export function tryCanonicalizeYouTubeVideoId(rawUrl: string): string | null {
  try {
    return parseYouTubeVideoUrl(rawUrl).externalId;
  } catch {
    return null;
  }
}
