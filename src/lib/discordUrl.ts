/**
 * Parsing/validation for Discord CDN video attachment URLs (frontend copy —
 * kept in sync with the backend's src/lib/discordUrl.ts; duplicated
 * because frontend and backend are separate npm packages in this PoC,
 * mirroring lib/youtubeUrl.ts's existing convention).
 *
 * Phase 4I scope: exactly one thing — a single video file already uploaded
 * as a Discord message attachment, identified by the direct CDN link a
 * user copies from Discord ("Copy Link" on an attachment). This is
 * deliberately the smallest unit that fits the existing project_sources
 * model without any Discord bot/OAuth/API integration:
 *
 *   - NOT a message (no bot access to fetch message content/metadata)
 *   - NOT a channel or server (no crawling, no history sync)
 *   - NOT a link shared in Discord to some other host (e.g. a YouTube URL
 *     pasted into a Discord message — that is just a YouTube video; add it
 *     via the existing "Add YouTube Video" flow instead)
 *
 * A Discord attachment CDN URL has the shape
 *   https://cdn.discordapp.com/attachments/<channel_id>/<attachment_id>/<filename>?ex=...&is=...&hm=...
 * (or the media.discordapp.net proxy host). Unlike a YouTube video id, the
 * query string's signature is REQUIRED to actually fetch the file and
 * cannot be regenerated from the attachment id alone — Discord signs and
 * expires these links server-side, and refreshing an expired link would
 * require a bot re-fetching the original message (out of scope for this
 * phase). See acquireDiscordVideo.ts for how this constrains acquisition.
 */

export class DiscordUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordUrlParseError";
  }
}

export interface ParsedDiscordVideo {
  /** The stable attachment id — never the full URL — used as project_sources.external_id. */
  externalId: string;
  /** The exact validated URL (query string included) — Discord's signature can't be reconstructed from externalId alone, so this is stored verbatim rather than normalized. */
  sourceUrl: string;
}

// Exact-match allowlist (never a suffix/substring check) — the same
// SSRF-hardening rigor as youtubeUrl.ts's WATCH_HOSTS/SHORT_HOSTS: a
// hostname like "cdn.discordapp.com.evil.example" never matches.
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

// Discord snowflake ids are unsigned 64-bit integers — digits only, no
// upper bound enforced beyond "looks like a snowflake", since Discord's id
// epoch/format is an external system this code doesn't own.
const SNOWFLAKE_PATTERN = /^[0-9]{1,20}$/;

const ATTACHMENT_PATH_PATTERN = /^\/attachments\/([0-9]{1,20})\/([0-9]{1,20})\/([^/]+)$/;

// Phase 4I scope is video only — the same "video" boundary Phase 4H-A/4H-B
// established for YouTube. An image/PDF/audio attachment is rejected here,
// never silently accepted and passed to the video-analysis pipeline.
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "m4v"]);

function fileExtension(filename: string): string | null {
  const idx = filename.lastIndexOf(".");
  if (idx === -1 || idx === filename.length - 1) return null;
  return filename.slice(idx + 1).toLowerCase();
}

/**
 * Parses and validates a Discord CDN attachment URL, returning its stable
 * `externalId` (the attachment id) and the exact `sourceUrl` (verbatim,
 * signature included). Throws DiscordUrlParseError (never a generic Error)
 * for anything that isn't exactly a video attachment on an exact-match
 * Discord CDN host.
 */
export function parseDiscordVideoUrl(rawUrl: string): ParsedDiscordVideo {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new DiscordUrlParseError("Discord attachment URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DiscordUrlParseError("The provided value is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new DiscordUrlParseError("Only https:// Discord attachment URLs are supported.");
  }

  const hostname = url.hostname.toLowerCase();
  if (!DISCORD_CDN_HOSTS.has(hostname)) {
    throw new DiscordUrlParseError(`Expected a cdn.discordapp.com or media.discordapp.net attachment URL, got hostname "${url.hostname}".`);
  }

  const match = ATTACHMENT_PATH_PATTERN.exec(url.pathname);
  if (!match) {
    throw new DiscordUrlParseError("Expected a Discord attachment URL of the form /attachments/<channel_id>/<attachment_id>/<filename>.");
  }
  const [, , attachmentId, filename] = match;
  if (!SNOWFLAKE_PATTERN.test(attachmentId)) {
    throw new DiscordUrlParseError("Could not find a valid Discord attachment id in this URL.");
  }

  const extension = fileExtension(decodeURIComponent(filename));
  if (!extension || !VIDEO_EXTENSIONS.has(extension)) {
    throw new DiscordUrlParseError("Only video attachments are supported yet (.mp4, .mov, .webm, .mkv, .m4v).");
  }

  return {
    externalId: attachmentId,
    // Verbatim, including the query string — see the module doc comment on
    // why this can't be normalized/reconstructed the way a YouTube URL is.
    sourceUrl: url.toString(),
  };
}
