/**
 * Builds the authorized Mux HLS URL for a signed playback ID, per Mux's
 * documented format:
 *   https://stream.mux.com/{PLAYBACK_ID}.m3u8?token={TOKEN}
 *
 * The returned string is a bearer credential in URL form. Callers MUST NOT
 * log it, return it to any client, or include it in any error message.
 * Register it with the redactor immediately after building it.
 */

export class InvalidMuxAssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMuxAssetError";
  }
}

export function buildSignedMuxHlsUrl(signedPlaybackId: string, token: string): string {
  if (!signedPlaybackId) {
    throw new InvalidMuxAssetError("Lesson has no signed_playback_id.");
  }
  if (!token) {
    throw new InvalidMuxAssetError("Lesson has no signed_video_playback_token.");
  }
  return `https://stream.mux.com/${encodeURIComponent(signedPlaybackId)}.m3u8?token=${encodeURIComponent(token)}`;
}
