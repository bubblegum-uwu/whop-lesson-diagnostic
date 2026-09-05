import { describe, it, expect } from "vitest";
import {
  buildDiagnosticDisplayPayload,
  assertNoForbiddenKeys,
} from "../diagnosticPayload";
import { sanitizeLessonResponse } from "../sanitize";
import { parseWhopLessonUrl } from "../whopUrl";
import type { WhopCourseLessonResponse } from "../whopTypes";

const SCARFACE_URL =
  "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/";

const rawLesson: WhopCourseLessonResponse = {
  id: "lesn_6XyV2SKHYoU4YZdlMF81kl",
  title: "Test Lesson",
  order: 1,
  lesson_type: "video",
  visibility: "visible",
  content: null,
  embed_type: null,
  embed_id: null,
  video_asset: {
    id: "mux_abc123",
    asset_id: "asset_xyz",
    playback_id: "pb_public",
    signed_playback_id: "pb_signed",
    status: "ready",
    audio_only: false,
    duration_seconds: 100,
    signed_video_playback_token: "SECRET-VIDEO-TOKEN",
    signed_thumbnail_playback_token: "SECRET-THUMB-TOKEN",
    signed_storyboard_playback_token: "SECRET-STORYBOARD-TOKEN",
    created_at: "2023-12-01T05:00:00.401Z",
    updated_at: "2023-12-01T05:00:00.401Z",
    finished_uploading_at: null,
  },
};

describe("buildDiagnosticDisplayPayload", () => {
  it("builds a payload containing only sanitized fields and URL-derived IDs", () => {
    const urlIds = parseWhopLessonUrl(SCARFACE_URL);
    const sanitizedLesson = sanitizeLessonResponse(rawLesson);
    const payload = buildDiagnosticDisplayPayload(urlIds, sanitizedLesson);

    expect(payload.requested_url_ids).toEqual({
      experience_id: "exp_gdmood6JIzSsE7",
      course_id: "cors_4lb7N3oassoZwHJvrufOYy",
      lesson_id: "lesn_6XyV2SKHYoU4YZdlMF81kl",
    });
    expect(payload.lesson.video_asset?.signed_video_playback_token_present).toBe(true);
  });

  it("never includes an OAuth access_token, refresh_token, or id_token", () => {
    const urlIds = parseWhopLessonUrl(SCARFACE_URL);
    const sanitizedLesson = sanitizeLessonResponse(rawLesson);
    const payload = buildDiagnosticDisplayPayload(urlIds, sanitizedLesson);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("id_token");
    expect(serialized).not.toContain("SECRET-VIDEO-TOKEN");
  });

  it("throws if an OAuth token is ever smuggled into the display object", () => {
    const urlIds = parseWhopLessonUrl(SCARFACE_URL);
    const sanitizedLesson = sanitizeLessonResponse(rawLesson);

    const tampered = {
      ...buildDiagnosticDisplayPayload(urlIds, sanitizedLesson),
      // Simulate a future bug that accidentally attaches a token.
      debug: { access_token: "leaked-token-value" },
    };

    expect(() => assertNoForbiddenKeys(tampered)).toThrow(/forbidden key/i);
  });

  it("throws if a client_secret is ever smuggled into the display object", () => {
    const tampered = { config: { client_secret: "should-never-be-here" } };
    expect(() => assertNoForbiddenKeys(tampered)).toThrow(/forbidden key/i);
  });

  it("does not throw for a clean, token-free object", () => {
    expect(() =>
      assertNoForbiddenKeys({ a: 1, b: { c: [1, 2, { d: "safe" }] } }),
    ).not.toThrow();
  });
});
