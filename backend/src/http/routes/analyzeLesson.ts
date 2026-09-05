import type { Request, Response } from "express";
import { requireBearerToken, MissingAuthorizationError } from "../../lib/authHeader.js";
import { globalRedactor } from "../../lib/redact.js";
import { logger } from "../../lib/logger.js";
import { startSse, sendSseEvent } from "../sse.js";
import {
  analyzeLesson,
  PipelineError,
  SchemaValidationError,
  STAGE_LABELS,
  type AnalyzeLessonDeps,
} from "../../pipeline/analyzeLesson.js";

export interface AnalyzeLessonRequestBody {
  lessonUrl?: string;
}

/**
 * Builds the Express route handler for POST /api/analyze-lesson.
 * `depsFactory` is called per-request so per-request state (like a
 * request-scoped redactor) can be wired in if desired; for this PoC we
 * reuse the process-wide redactor/logger and a shared deps object.
 */
export function createAnalyzeLessonHandler(deps: AnalyzeLessonDeps) {
  return async function analyzeLessonHandler(req: Request, res: Response): Promise<void> {
    let whopAccessToken: string;
    try {
      whopAccessToken = requireBearerToken(req.headers.authorization);
    } catch (err) {
      if (err instanceof MissingAuthorizationError) {
        res.status(401).json({ error: { message: err.message, type: "missing_authorization" } });
        return;
      }
      throw err;
    }
    globalRedactor.register(whopAccessToken);

    const body = req.body as AnalyzeLessonRequestBody;
    const lessonUrl = typeof body?.lessonUrl === "string" ? body.lessonUrl : undefined;
    if (!lessonUrl) {
      res.status(400).json({ error: { message: "Missing lessonUrl in request body.", type: "invalid_request" } });
      return;
    }

    startSse(res);

    try {
      const result = await analyzeLesson(lessonUrl, whopAccessToken, deps, (stage) => {
        sendSseEvent(res, { type: "stage", stage, label: STAGE_LABELS[stage] });
      });
      sendSseEvent(res, { type: "result", payload: result.analysis });
    } catch (err) {
      const safeMessage = globalRedactor.redact(
        err instanceof Error ? err.message : "Unknown server error.",
      );
      logger.error("analyze-lesson pipeline failed", { message: safeMessage });

      if (err instanceof PipelineError) {
        sendSseEvent(res, { type: "error", message: safeMessage, stage: err.stage });
      } else if (err instanceof SchemaValidationError) {
        sendSseEvent(res, { type: "error", message: safeMessage, stage: "validating_result" });
      } else {
        sendSseEvent(res, { type: "error", message: safeMessage });
      }
    } finally {
      res.end();
    }
  };
}
