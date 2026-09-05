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

/**
 * Mirrors the fields Whop's documented `GET /courses/{id}` returns. Used
 * ONLY for course metadata and the chapter hierarchy/ordering — per design,
 * the *lessons* nested here are not treated as the authoritative lesson
 * inventory (that's the paginated `course_lessons` list below); they're
 * used solely to join a lesson id back to its chapter and chapter order.
 */
export interface WhopCourseChapterLessonRef {
  id: string;
  order: number;
}

export interface WhopCourseChapter {
  id: string;
  title: string;
  order: number;
  lessons: WhopCourseChapterLessonRef[];
}

export interface WhopCourseResponse {
  id: string;
  title: string;
  chapters: WhopCourseChapter[];
}

/** Cursor pagination envelope used by Whop's list endpoints. */
export interface WhopPageInfo {
  end_cursor: string | null;
  has_next_page: boolean;
}

/**
 * One item from the documented paginated `GET /course_lessons?course_id=`
 * list — the authoritative lesson inventory for course sync. Same
 * underlying CourseLesson resource as the single-lesson retrieve endpoint,
 * so it mirrors {@link WhopCourseLessonResponse} plus its list-only `order`.
 */
export interface WhopCourseLessonListItem {
  id: string;
  title: string;
  order: number;
  lesson_type: string;
  visibility: string;
  video_asset: WhopVideoAsset | null;
  [key: string]: unknown;
}

export interface WhopCourseLessonListResponse {
  data: WhopCourseLessonListItem[];
  page_info: WhopPageInfo;
}
