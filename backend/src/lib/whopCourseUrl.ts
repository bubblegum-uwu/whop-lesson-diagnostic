/**
 * Parsing helper for Whop COURSE URLs — a NEW, separate parser from
 * whopUrl.ts (which requires the full .../courses/{course_id}/lessons/{lesson_id}/
 * shape and is unchanged by this file). Phase 4K: connecting an additional
 * Whop course to a project starts from a pasted course URL, not a lesson
 * URL.
 *
 * Expected shape (the same Whop app routing, one level up):
 *   https://whop.com/{company-slug}/{experience_id}/app/courses/{course_id}/
 */

export class WhopCourseUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhopCourseUrlParseError";
  }
}

export interface ParsedWhopCourseUrl {
  companySlug: string;
  experienceId: string;
  courseId: string;
}

export function parseWhopCourseUrl(rawUrl: string): ParsedWhopCourseUrl {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new WhopCourseUrlParseError("Whop course URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WhopCourseUrlParseError("The provided value is not a valid URL.");
  }

  if (url.hostname !== "whop.com" && url.hostname !== "www.whop.com") {
    throw new WhopCourseUrlParseError(`Expected a whop.com URL, got hostname "${url.hostname}".`);
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const [companySlug, experienceId, appSegment, coursesSegment, courseId] = segments;

  if (!companySlug || !experienceId || appSegment !== "app" || coursesSegment !== "courses" || !courseId) {
    throw new WhopCourseUrlParseError(
      "URL does not match the expected Whop course URL shape: /{company-slug}/{experience_id}/app/courses/{course_id}/",
    );
  }
  if (!experienceId.startsWith("exp_")) {
    throw new WhopCourseUrlParseError(`Expected experience ID to start with "exp_", got "${experienceId}".`);
  }
  if (!courseId.startsWith("cors_")) {
    throw new WhopCourseUrlParseError(`Expected course ID to start with "cors_", got "${courseId}".`);
  }

  return { companySlug, experienceId, courseId };
}
