import type { Request, Response } from "express";
import type { Pool } from "pg";
import { syncCourse, type CourseSyncConfig } from "../../pipeline/courseSync.js";
import type { WhopCourseClient } from "../../whop/courseClient.js";
import type { WhopOAuthClient } from "../../whop/oauthClient.js";
import { getValidAccessToken, AuthRequiredError } from "../../whop/sessionService.js";
import { globalRedactor } from "../../lib/redact.js";
import { logger } from "../../lib/logger.js";

export interface CourseSyncRouteDeps {
  pool: Pool;
  courseClient: WhopCourseClient;
  oauthClient: WhopOAuthClient;
  refreshTokenEncryptionKey: string;
  course: CourseSyncConfig;
}

/**
 * POST /api/course/sync — discovers/refreshes the course's lesson catalog.
 * Uses the backend's own stored Whop session (refreshing if needed) rather
 * than requiring the caller to hold a fresh bearer token — course sync must
 * keep working even if triggered outside an interactive browser session.
 */
export function createCourseSyncHandler(deps: CourseSyncRouteDeps) {
  return async function courseSyncHandler(_req: Request, res: Response): Promise<void> {
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(deps.pool, deps.oauthClient, deps.refreshTokenEncryptionKey);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        res.status(401).json({ error: { message: err.message, type: "auth_required" } });
        return;
      }
      throw err;
    }
    globalRedactor.register(accessToken);

    try {
      const result = await syncCourse(deps.pool, deps.courseClient, accessToken, deps.course);
      res.status(200).json(result);
    } catch (err) {
      const safeMessage = globalRedactor.redact(err instanceof Error ? err.message : "Course sync failed.");
      logger.error("course sync failed", { message: safeMessage });
      res.status(502).json({ error: { message: safeMessage, type: "course_sync_failed" } });
    }
  };
}
