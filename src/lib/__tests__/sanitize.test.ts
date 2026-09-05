import { describe, it, expect } from "vitest";
import { sanitizeLessonResponse } from "../sanitize";
import type { WhopCourseLessonResponse } from "../whopTypes";

function makeRawLesson(
  overrides: Partial<WhopCourseLessonResponse> = {},
): WhopCourseLessonResponse {
  return {
    id: "lesn_6XyV2SKHYoU4YZdlMF81kl",
    title: "Understanding Candlestick Patterns",
    order: 3,
    lesson_type: "video",
    visibility: "visible",
    content: "In this lesson, we cover the basics.",
    embed_type: null,
    embed_id: null,
    video_asset: {
      id: "mux_abc123",
      asset_id: "asset_xyz",
      playback_id: "pb_public",
      signed_playback_id: "pb_signed",
      status: "ready",
      audio_only: false,
      duration_seconds: 812,
      signed_video_playback_token: "SUPER-SECRET-TOKEN-VALUE",
      signed_thumbnail_playback_token: "thumb-token",
      signed_storyboard_playback_token: "storyboard-token",
      created_at: "2023-12-01T05:00:00.401Z",
      updated_at: "2023-12-01T05:00:00.401Z",
      finished_uploading_at: "2023-12-01T05:10:00.401Z",
    },
    days_from_course_start_until_unlock: null,
    created_at: "2023-12-01T05:00:00.401Z",
    thumbnail: { url: "https://media.whop.com/abc123/optimized.jpg" },
    main_pdf: null,
    assessment_questions: [],
    attachments: [],
    ...overrides,
  };
}

describe("sanitizeLessonResponse", () => {
  it("copies the allow-listed top-level fields", () => {
    const sanitized = sanitizeLessonResponse(makeRawLesson());
    expect(sanitized).toMatchObject({
      id: "lesn_6XyV2SKHYoU4YZdlMF81kl",
      title: "Understanding Candlestick Patterns",
      lesson_type: "video",
      visibility: "visible",
      content: "In this lesson, we cover the basics.",
      embed_type: null,
      embed_id: null,
    });
  });

  it("copies allow-listed video_asset fields", () => {
    const sanitized = sanitizeLessonResponse(makeRawLesson());
    expect(sanitized.video_asset).toMatchObject({
      id: "mux_abc123",
      asset_id: "asset_xyz",
      duration_seconds: 812,
      audio_only: false,
      status: "ready",
      playback_id: "pb_public",
      signed_playback_id: "pb_signed",
    });
  });

  it("never includes the raw signed_video_playback_token value", () => {
    const sanitized = sanitizeLessonResponse(makeRawLesson());
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("SUPER-SECRET-TOKEN-VALUE");
    expect(serialized).not.toContain("signed_video_playback_token\":\"");
  });

  it("exposes signed_video_playback_token_present: true when a token exists", () => {
    const sanitized = sanitizeLessonResponse(makeRawLesson());
    expect(sanitized.video_asset?.signed_video_playback_token_present).toBe(true);
  });

  it("exposes signed_video_playback_token_present: false when no token exists", () => {
    const sanitized = sanitizeLessonResponse(
      makeRawLesson({
        video_asset: {
          id: "mux_abc123",
          asset_id: null,
          playback_id: null,
          signed_playback_id: null,
          status: "uploading",
          audio_only: false,
          duration_seconds: null,
          signed_video_playback_token: null,
          signed_thumbnail_playback_token: null,
          signed_storyboard_playback_token: null,
          created_at: "2023-12-01T05:00:00.401Z",
          updated_at: "2023-12-01T05:00:00.401Z",
          finished_uploading_at: null,
        },
      }),
    );
    expect(sanitized.video_asset?.signed_video_playback_token_present).toBe(false);
  });

  it("handles a null video_asset (e.g. text-type lessons)", () => {
    const sanitized = sanitizeLessonResponse(makeRawLesson({ video_asset: null }));
    expect(sanitized.video_asset).toBeNull();
  });

  it("does not leak unrelated/undocumented raw fields", () => {
    const sanitized = sanitizeLessonResponse(
      makeRawLesson({ some_internal_field: "should-not-appear" } as Partial<WhopCourseLessonResponse>),
    );
    expect(JSON.stringify(sanitized)).not.toContain("should-not-appear");
  });
});
