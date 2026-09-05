import type {
  WhopCourseResponse,
  WhopCourseLessonListResponse,
  WhopErrorResponse,
} from "./types.js";
import { WhopApiError, WhopUnauthorizedError, WhopForbiddenError, WhopNotFoundError } from "./client.js";

/**
 * Course discovery, split across the two documented endpoints per design:
 *   - `GET /courses/{id}`               → course metadata + chapter hierarchy/ordering only
 *   - `GET /course_lessons?course_id=`  → the authoritative, paginated lesson inventory
 * The two are joined by lesson id in the course-sync service, not here.
 */

async function parseErrorAndThrow(res: Response): Promise<never> {
  const body = await res.json().catch(() => undefined);
  const err = (body as WhopErrorResponse | undefined)?.error;
  const message = typeof err?.message === "string" ? err.message : "Whop API error";
  const type = typeof err?.type === "string" ? err.type : "unknown_error";

  if (res.status === 401) throw new WhopUnauthorizedError(message, type);
  if (res.status === 403) throw new WhopForbiddenError(message, type);
  if (res.status === 404) throw new WhopNotFoundError(message, type);
  throw new WhopApiError(message, res.status, type);
}

export interface FetchCourse {
  (courseId: string, accessToken: string): Promise<WhopCourseResponse>;
}

export interface FetchCourseLessonsPage {
  (courseId: string, accessToken: string, after?: string): Promise<WhopCourseLessonListResponse>;
}

export interface WhopCourseClient {
  fetchCourse: FetchCourse;
  fetchCourseLessonsPage: FetchCourseLessonsPage;
}

const LESSONS_PAGE_SIZE = 50;

export function createWhopCourseClient(apiBase: string): WhopCourseClient {
  async function fetchCourse(courseId: string, accessToken: string): Promise<WhopCourseResponse> {
    const res = await fetch(`${apiBase}/courses/${encodeURIComponent(courseId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return parseErrorAndThrow(res);
    return (await res.json()) as WhopCourseResponse;
  }

  async function fetchCourseLessonsPage(
    courseId: string,
    accessToken: string,
    after?: string,
  ): Promise<WhopCourseLessonListResponse> {
    const params = new URLSearchParams({ course_id: courseId, first: String(LESSONS_PAGE_SIZE) });
    if (after) params.set("after", after);

    const res = await fetch(`${apiBase}/course_lessons?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return parseErrorAndThrow(res);
    return (await res.json()) as WhopCourseLessonListResponse;
  }

  return { fetchCourse, fetchCourseLessonsPage };
}

/** Follows `page_info.has_next_page` until every lesson for the course has been collected. */
export async function fetchAllCourseLessons(
  client: WhopCourseClient,
  courseId: string,
  accessToken: string,
) {
  const all: WhopCourseLessonListResponse["data"] = [];
  let after: string | undefined;
  for (;;) {
    const page = await client.fetchCourseLessonsPage(courseId, accessToken, after);
    all.push(...page.data);
    if (!page.page_info.has_next_page || !page.page_info.end_cursor) break;
    after = page.page_info.end_cursor;
  }
  return all;
}
