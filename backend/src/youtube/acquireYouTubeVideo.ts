import { parseYouTubeVideoUrl } from "../lib/youtubeUrl.js";
import type { VideoInputRef } from "../gemini/client.js";

/**
 * Phase 4H-B — the YouTube "acquisition adapter." Deliberately takes ONLY
 * `externalId` (never a raw/stored URL) — see the Phase 4H-B PR
 * description's security rule: acquisition must always reconstruct the
 * canonical https://www.youtube.com/watch?v=<id> URL from the already
 * -validated 11-character video id (project_sources.external_id, set once
 * by Phase 4H-A's parseYouTubeVideoUrl at add-time), never from
 * project_sources.source_url. Even if source_url were unexpectedly
 * modified in the database to something malicious, this function has no
 * parameter through which that value could ever reach it — a raw URL is
 * structurally impossible to pass here.
 *
 * Re-running the reconstructed URL through parseYouTubeVideoUrl (the same
 * frozen Phase 4H-A parser, unchanged) both rebuilds the canonical form and
 * re-validates it — belt-and-suspenders against a corrupted/malformed
 * external_id ever reaching Gemini. This is a PURE, synchronous function:
 * no network call, no Gemini Files upload, no ffmpeg — per the approved
 * live spike (see the Phase 4H-B PR description), Gemini fetches the video
 * server-side once given the URL directly.
 */
export function acquireYouTubeVideo(externalId: string): VideoInputRef {
  const parsed = parseYouTubeVideoUrl(`https://www.youtube.com/watch?v=${externalId}`);
  return { uri: parsed.sourceUrl };
}
