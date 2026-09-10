/**
 * Parsing/validation for public YouTube video URLs (backend copy — kept in
 * sync with the frontend's src/lib/youtubeUrl.ts; duplicated because
 * frontend and backend are separate npm packages in this PoC, mirroring
 * lib/whopUrl.ts's existing convention).
 *
 * Phase 4H-A scope only: a single public video URL
 * (youtube.com/watch?v=... or youtu.be/...). Never a playlist, channel, or
 * arbitrary web URL. This is a PURE parser — it never performs a network
 * fetch, so it is safe to call before any authorization/auth check.
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

// Exactly 11 characters from YouTube's video-id alphabet — matches every
// real YouTube video id and rejects anything that merely looks URL-shaped.
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// Exact-match allowlists (never a suffix/substring check) — this alone is
// what keeps a hostname like "youtube.com.evil.example", "localhost", or a
// raw IP literal from ever being accepted: none of them equal any member
// of these sets, and there is no fallback path that accepts a URL by
// merely finding "youtube.com" somewhere inside it.
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

function rejectKnownUnsupportedPath(pathname: string): void {
  if (pathname === "/playlist" || pathname.startsWith("/playlist/")) {
    throw new YouTubeUrlParseError("Playlist URLs are not supported yet — add an individual video URL.");
  }
  if (
    pathname.startsWith("/channel/") ||
    pathname.startsWith("/c/") ||
    pathname.startsWith("/user/") ||
    pathname.startsWith("/@")
  ) {
    throw new YouTubeUrlParseError("Channel URLs are not supported yet — add an individual video URL.");
  }
}

/**
 * Parses and validates a public YouTube video URL, returning its canonical
 * identity: a stable `externalId` (never the raw URL) and a normalized
 * `sourceUrl` for display/provenance. Throws YouTubeUrlParseError (never a
 * generic Error) for anything that isn't exactly one of the two supported
 * individual-video forms — malformed input, a non-YouTube host, `file://`
 * and every other non-`https:` scheme, a playlist/channel URL, or a
 * pathname that doesn't resolve to a valid 11-character video id.
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
    if (url.pathname !== "/watch") {
      throw new YouTubeUrlParseError("Expected a youtube.com/watch?v=... video URL.");
    }
    externalId = url.searchParams.get("v");
  } else if (SHORT_HOSTS.has(hostname)) {
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length !== 1) {
      throw new YouTubeUrlParseError("Expected a youtu.be/VIDEO_ID video URL.");
    }
    externalId = segments[0];
  } else {
    throw new YouTubeUrlParseError(`Expected a youtube.com or youtu.be URL, got hostname "${url.hostname}".`);
  }

  if (!externalId || !VIDEO_ID_PATTERN.test(externalId)) {
    throw new YouTubeUrlParseError("Could not find a valid YouTube video ID in this URL.");
  }

  return {
    externalId,
    sourceUrl: `https://www.youtube.com/watch?v=${externalId}`,
  };
}
