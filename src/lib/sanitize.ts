import type { WhopCourseLessonResponse } from "./whopTypes";

/**
 * Sanitized video asset info safe to render in the browser UI.
 * Notably, `signed_video_playback_token` itself is never included here —
 * only a boolean presence flag.
 */
export interface SanitizedVideoAsset {
  id: string;
  asset_id: string | null;
  duration_seconds: number | null;
  audio_only: boolean;
  status: string;
  playback_id: string | null;
  signed_playback_id: string | null;
  signed_video_playback_token_present: boolean;
}

/** Sanitized lesson info safe to render in the browser UI. */
export interface SanitizedLesson {
  id: string;
  title: string;
  lesson_type: string;
  visibility: string;
  content: string | null;
  embed_type: string | null;
  embed_id: string | null;
  video_asset: SanitizedVideoAsset | null;
}

/**
 * Produces a sanitized, display-safe view of a raw Whop course lesson
 * API response.
 *
 * - Only the documented, allow-listed fields named in the diagnostic spec
 *   are copied over; nothing else from the raw response passes through.
 * - The actual `signed_video_playback_token` value is NEVER included.
 *   Only `signed_video_playback_token_present` (boolean) is derived.
 */
export function sanitizeLessonResponse(
  raw: WhopCourseLessonResponse,
): SanitizedLesson {
  const rawVideoAsset = raw.video_asset ?? null;

  const video_asset: SanitizedVideoAsset | null = rawVideoAsset
    ? {
        id: rawVideoAsset.id,
        asset_id: rawVideoAsset.asset_id ?? null,
        duration_seconds: rawVideoAsset.duration_seconds ?? null,
        audio_only: Boolean(rawVideoAsset.audio_only),
        status: rawVideoAsset.status,
        playback_id: rawVideoAsset.playback_id ?? null,
        signed_playback_id: rawVideoAsset.signed_playback_id ?? null,
        signed_video_playback_token_present: Boolean(
          rawVideoAsset.signed_video_playback_token,
        ),
      }
    : null;

  return {
    id: raw.id,
    title: raw.title,
    lesson_type: raw.lesson_type,
    visibility: raw.visibility,
    content: raw.content ?? null,
    embed_type: raw.embed_type ?? null,
    embed_id: raw.embed_id ?? null,
    video_asset,
  };
}
