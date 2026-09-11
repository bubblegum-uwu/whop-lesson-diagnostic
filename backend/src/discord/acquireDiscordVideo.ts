import { parseDiscordVideoUrl } from "../lib/discordUrl.js";
import type { VideoInputRef } from "../gemini/client.js";

/**
 * Phase 4I — the Discord "acquisition adapter," the counterpart to
 * youtube/acquireYouTubeVideo.ts. Deliberately follows the same
 * "acquire, don't upload" boundary the approved YouTube spike established:
 * this is a PURE, synchronous function — no network call, no Gemini Files
 * upload, no ffmpeg. Gemini fetches the video server-side once given the
 * URL directly, exactly as it does for a YouTube URL.
 *
 * IMPORTANT DEVIATION FROM acquireYouTubeVideo, disclosed here rather than
 * silently diverging: YouTube's `externalId` alone reconstructs a stable,
 * canonical `https://www.youtube.com/watch?v=<id>` URL with no signature.
 * A Discord CDN attachment URL is signed and time-limited (its `ex`/`is`/
 * `hm` query parameters cannot be regenerated from the bare attachment id
 * — only Discord's own servers can reissue them, which would require a
 * bot re-fetching the original message, explicitly out of scope for this
 * phase). So this function cannot take `externalId` alone the way
 * acquireYouTubeVideo does; it must be given the persisted `sourceUrl` too.
 *
 * The security boundary is preserved differently, not dropped: the given
 * `sourceUrl` is revalidated through the exact same strict parser used at
 * add-time (host allowlist, path shape, video-extension allowlist), and
 * the parsed attachment id is cross-checked against the trusted, separately
 * -stored `externalId` before anything is ever handed to Gemini. A
 * source_url that doesn't parse as a genuine Discord CDN video URL, or
 * that parses but names a DIFFERENT attachment than the one on record, is
 * rejected outright — even a corrupted/tampered source_url can never
 * silently reach Gemini as if it were trusted.
 *
 * A signed Discord URL can also simply expire between when a source was
 * added and when Analyze is clicked — that surfaces as an ordinary Gemini
 * fetch failure, classified and persisted as a FAILED analysis exactly
 * like any other unavailable video (see worker/projectSourceAnalysisLoop.ts
 * / pipeline/errorClassification.ts), never a special case.
 */
export function acquireDiscordVideo(source: { externalId: string; sourceUrl: string }): VideoInputRef {
  const parsed = parseDiscordVideoUrl(source.sourceUrl);
  if (parsed.externalId !== source.externalId) {
    throw new Error("Discord source_url does not match the recorded attachment identity — refusing to acquire.");
  }
  return { uri: parsed.sourceUrl };
}
