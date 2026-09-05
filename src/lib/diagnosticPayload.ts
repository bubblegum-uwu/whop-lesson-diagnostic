import type { ParsedWhopLessonUrl } from "./whopUrl";
import type { SanitizedLesson } from "./sanitize";

/**
 * Field names that must NEVER appear anywhere in the diagnostic JSON shown
 * in the UI. This is a defense-in-depth guard: even though sanitizeLessonResponse
 * already strips the raw token, this list is checked again right before display
 * so that a future code change can't accidentally reintroduce a leak.
 */
export const FORBIDDEN_DISPLAY_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "signed_video_playback_token",
  "code_verifier",
  "client_secret",
] as const;

export interface DiagnosticDisplayPayload {
  requested_url_ids: {
    experience_id: string;
    course_id: string;
    lesson_id: string;
  };
  lesson: SanitizedLesson;
}

/**
 * Builds the exact JSON-serializable object rendered in the diagnostic UI.
 * Throws if any forbidden key is detected anywhere in the resulting object
 * graph (including nested), so a token can never silently leak to the screen.
 */
export function buildDiagnosticDisplayPayload(
  urlIds: ParsedWhopLessonUrl,
  lesson: SanitizedLesson,
): DiagnosticDisplayPayload {
  const payload: DiagnosticDisplayPayload = {
    requested_url_ids: {
      experience_id: urlIds.experienceId,
      course_id: urlIds.courseId,
      lesson_id: urlIds.lessonId,
    },
    lesson,
  };

  assertNoForbiddenKeys(payload);
  return payload;
}

/** Recursively scans an object/array for any forbidden key name. Throws on match. */
export function assertNoForbiddenKeys(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_DISPLAY_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Refusing to display diagnostic payload: forbidden key "${key}" found at ${path}.${key}`,
      );
    }
    assertNoForbiddenKeys(val, `${path}.${key}`);
  }
}
