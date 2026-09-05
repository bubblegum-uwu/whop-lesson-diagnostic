/**
 * Builds a lesson's canonical Whop URL server-side, the exact inverse of the
 * frontend's `parseWhopLessonUrl` (src/lib/whopUrl.ts):
 *   https://whop.com/{company-slug}/{experience_id}/app/courses/{course_id}/lessons/{lesson_id}/
 * Used at course-sync time so every persisted lesson always has a working
 * `source_url`, without depending on Whop's API to echo one back.
 */
export function buildLessonSourceUrl(
  companySlug: string,
  experienceId: string,
  courseId: string,
  lessonId: string,
): string {
  return `https://whop.com/${companySlug}/${experienceId}/app/courses/${courseId}/lessons/${lessonId}/`;
}
