/**
 * Types mirroring the documented Whop REST API schema for
 * `GET /api/v1/course_lessons/{id}`.
 *
 * Source: https://docs.whop.com/api-reference/course-lessons/retrieve-course-lesson
 * (OpenAPI component: CourseLesson / video_asset)
 *
 * Only the fields relevant to this diagnostic are modeled in full;
 * everything else on the raw response is treated as unknown/opaque and
 * deliberately dropped during sanitization.
 */

export type MuxAssetStatus = "uploading" | "created" | "ready";

export type EmbedType = "youtube" | "loom";

export type LessonType =
  | "text"
  | "video"
  | "pdf"
  | "multi"
  | "quiz"
  | "knowledge_check";

export type LessonVisibility = "visible" | "hidden";

export interface WhopVideoAsset {
  id: string;
  asset_id: string | null;
  playback_id: string | null;
  signed_playback_id: string | null;
  status: MuxAssetStatus;
  audio_only: boolean;
  duration_seconds: number | null;
  signed_video_playback_token: string | null;
  signed_thumbnail_playback_token: string | null;
  signed_storyboard_playback_token: string | null;
  created_at: string;
  updated_at: string;
  finished_uploading_at: string | null;
}

/** Raw shape returned by the Whop API for a course lesson. */
export interface WhopCourseLessonResponse {
  id: string;
  title: string;
  order: number;
  lesson_type: LessonType;
  visibility: LessonVisibility;
  content: string | null;
  embed_type: EmbedType | null;
  embed_id: string | null;
  video_asset: WhopVideoAsset | null;
  // Additional documented fields we don't need to display but may be present:
  days_from_course_start_until_unlock?: number | null;
  created_at?: string;
  thumbnail?: { url: string | null } | null;
  main_pdf?: unknown;
  assessment_questions?: unknown;
  attachments?: unknown;
  [key: string]: unknown;
}

/** Standard Whop error envelope. */
export interface WhopErrorResponse {
  error: {
    code?: string | null;
    message: string;
    param?: string | null;
    type: string;
  };
}
