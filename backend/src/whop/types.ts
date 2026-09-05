/** Mirrors the fields of Whop's documented CourseLesson schema that the backend needs. */
export interface WhopVideoAsset {
  id: string;
  asset_id: string | null;
  playback_id: string | null;
  signed_playback_id: string | null;
  status: "uploading" | "created" | "ready";
  audio_only: boolean;
  duration_seconds: number | null;
  signed_video_playback_token: string | null;
}

export interface WhopCourseLessonResponse {
  id: string;
  title: string;
  lesson_type: string;
  visibility: string;
  embed_type: string | null;
  embed_id: string | null;
  video_asset: WhopVideoAsset | null;
  [key: string]: unknown;
}

export interface WhopErrorResponse {
  error: {
    code?: string | null;
    message: string;
    type: string;
  };
}
