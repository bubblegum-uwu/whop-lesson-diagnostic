import type { WhopCourseLessonResponse, WhopErrorResponse } from "./types.js";

/**
 * Server-side call to the documented Whop endpoint:
 *   GET https://api.whop.com/api/v1/course_lessons/{lesson_id}
 *
 * We ALWAYS re-fetch the lesson server-side using the user's bearer token
 * rather than trusting any signed_playback_id/token the client might send —
 * this guarantees we use a fresh, valid Mux token and prevents a client
 * from asking us to fetch an arbitrary lesson it doesn't actually have
 * access to being disguised as one it does.
 */

export class WhopApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly whopErrorType: string,
  ) {
    super(message);
    this.name = "WhopApiError";
  }
}

export class WhopUnauthorizedError extends WhopApiError {
  constructor(message: string, whopErrorType: string) {
    super(message, 401, whopErrorType);
    this.name = "WhopUnauthorizedError";
  }
}

export class WhopForbiddenError extends WhopApiError {
  constructor(message: string, whopErrorType: string) {
    super(message, 403, whopErrorType);
    this.name = "WhopForbiddenError";
  }
}

export class WhopNotFoundError extends WhopApiError {
  constructor(message: string, whopErrorType: string) {
    super(message, 404, whopErrorType);
    this.name = "WhopNotFoundError";
  }
}

export interface FetchWhopLesson {
  (lessonId: string, accessToken: string): Promise<WhopCourseLessonResponse>;
}

export function createWhopClient(apiBase: string): { fetchLesson: FetchWhopLesson } {
  async function fetchLesson(
    lessonId: string,
    accessToken: string,
  ): Promise<WhopCourseLessonResponse> {
    const res = await fetch(`${apiBase}/course_lessons/${encodeURIComponent(lessonId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    const body = await res.json().catch(() => undefined);

    if (res.ok) {
      return body as WhopCourseLessonResponse;
    }

    const err = (body as WhopErrorResponse | undefined)?.error;
    const message = typeof err?.message === "string" ? err.message : "Whop API error";
    const type = typeof err?.type === "string" ? err.type : "unknown_error";

    if (res.status === 401) throw new WhopUnauthorizedError(message, type);
    if (res.status === 403) throw new WhopForbiddenError(message, type);
    if (res.status === 404) throw new WhopNotFoundError(message, type);
    throw new WhopApiError(message, res.status, type);
  }

  return { fetchLesson };
}
