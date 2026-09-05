/**
 * Parsing helpers for Whop course lesson URLs.
 *
 * Expected URL shape (as documented by Whop's app routing):
 *   https://whop.com/{company-slug}/{experience_id}/app/courses/{course_id}/lessons/{lesson_id}/
 *
 * Example (the Scarface Trades Mastermind test lesson):
 *   https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/
 */

export interface ParsedWhopLessonUrl {
  companySlug: string;
  experienceId: string;
  courseId: string;
  lessonId: string;
}

export class WhopUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopUrlParseError";
  }
}

/**
 * Parses a Whop course lesson URL and extracts the company slug,
 * experience ID, course ID, and lesson ID.
 *
 * Throws WhopUrlParseError if the URL does not match the expected shape.
 */
export function parseWhopLessonUrl(rawUrl: string): ParsedWhopLessonUrl {
  const trimmed = rawUrl.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WhopUrlParseError("The provided value is not a valid URL.");
  }

  if (url.hostname !== "whop.com" && url.hostname !== "www.whop.com") {
    throw new WhopUrlParseError(
      `Expected a whop.com URL, got hostname "${url.hostname}".`,
    );
  }

  // Split path into non-empty segments.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  // Expected segments:
  // [companySlug, experienceId, "app", "courses", courseId, "lessons", lessonId]
  const [
    companySlug,
    experienceId,
    appSegment,
    coursesSegment,
    courseId,
    lessonsSegment,
    lessonId,
  ] = segments;

  if (
    !companySlug ||
    !experienceId ||
    appSegment !== "app" ||
    coursesSegment !== "courses" ||
    !courseId ||
    lessonsSegment !== "lessons" ||
    !lessonId
  ) {
    throw new WhopUrlParseError(
      "URL does not match the expected Whop lesson URL shape: " +
        "/{company-slug}/{experience_id}/app/courses/{course_id}/lessons/{lesson_id}/",
    );
  }

  if (!experienceId.startsWith("exp_")) {
    throw new WhopUrlParseError(
      `Expected experience ID to start with "exp_", got "${experienceId}".`,
    );
  }

  if (!courseId.startsWith("cors_")) {
    throw new WhopUrlParseError(
      `Expected course ID to start with "cors_", got "${courseId}".`,
    );
  }

  if (!lessonId.startsWith("lesn_")) {
    throw new WhopUrlParseError(
      `Expected lesson ID to start with "lesn_", got "${lessonId}".`,
    );
  }

  return { companySlug, experienceId, courseId, lessonId };
}

/** Convenience helper for callers that only need the lesson ID. */
export function extractLessonId(rawUrl: string): string {
  return parseWhopLessonUrl(rawUrl).lessonId;
}

/** Convenience helper for callers that only need the course ID. */
export function extractCourseId(rawUrl: string): string {
  return parseWhopLessonUrl(rawUrl).courseId;
}

/** Convenience helper for callers that only need the experience ID. */
export function extractExperienceId(rawUrl: string): string {
  return parseWhopLessonUrl(rawUrl).experienceId;
}
