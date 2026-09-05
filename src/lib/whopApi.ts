import type { WhopCourseLessonResponse, WhopErrorResponse } from "./whopTypes";

export const WHOP_API_BASE = "https://api.whop.com/api/v1";

export type LessonFetchOutcome =
  | { kind: "success"; status: 200; data: WhopCourseLessonResponse }
  | { kind: "unauthorized"; status: 401; error: SanitizedApiError }
  | { kind: "forbidden"; status: 403; error: SanitizedApiError }
  | { kind: "not_found"; status: 404; error: SanitizedApiError }
  | { kind: "other_error"; status: number; error: SanitizedApiError };

/** A sanitized (safe-to-display) version of Whop's error envelope. */
export interface SanitizedApiError {
  type: string;
  message: string;
  code: string | null;
}

function sanitizeError(raw: unknown): SanitizedApiError {
  const err = (raw as WhopErrorResponse | undefined)?.error;
  return {
    type: typeof err?.type === "string" ? err.type : "unknown_error",
    message:
      typeof err?.message === "string" ? err.message : "No error message provided.",
    code: typeof err?.code === "string" ? err.code : null,
  };
}

/**
 * Calls the documented Whop endpoint:
 *   GET https://api.whop.com/api/v1/course_lessons/{lesson_id}
 *
 * Never throws for expected HTTP error statuses (401/403/404/other) —
 * instead returns a discriminated-union outcome so the UI can render
 * the exact, sanitized status and error without attempting workarounds.
 */
export async function fetchCourseLesson(
  lessonId: string,
  accessToken: string,
): Promise<LessonFetchOutcome> {
  const res = await fetch(`${WHOP_API_BASE}/course_lessons/${encodeURIComponent(lessonId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const body = await res.json().catch(() => undefined);

  if (res.ok) {
    return { kind: "success", status: 200, data: body as WhopCourseLessonResponse };
  }

  const error = sanitizeError(body);

  switch (res.status) {
    case 401:
      return { kind: "unauthorized", status: 401, error };
    case 403:
      return { kind: "forbidden", status: 403, error };
    case 404:
      return { kind: "not_found", status: 404, error };
    default:
      return { kind: "other_error", status: res.status, error };
  }
}
