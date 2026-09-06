import express, { type Express } from "express";
import { requireApiRoleEnv, type AppConfig } from "../config.js";
import { corsMiddleware } from "../lib/cors.js";
import { createWhopClient } from "../whop/client.js";
import { createWhopCourseClient } from "../whop/courseClient.js";
import { createWhopOAuthClient } from "../whop/oauthClient.js";
import { createGeminiClient } from "../gemini/client.js";
import { remuxToMp4 } from "../ffmpeg/remux.js";
import { createPool } from "../db/pool.js";
import { createAnalyzeLessonHandler } from "./routes/analyzeLesson.js";
import {
  createEstablishSessionHandler,
  createAuthStatusHandler,
  createDisconnectHandler,
} from "./routes/auth.js";
import { createCourseSyncHandler } from "./routes/courseSync.js";
import { createCourseLessonsHandler } from "./routes/courseLessons.js";
import { createEnqueueJobsHandler, createRetryJobHandler, createCancelJobHandler, createGetJobHandler } from "./routes/analysisJobs.js";
import { createLessonAnalysisDetailHandler } from "./routes/lessonAnalysisDetail.js";
import { createAnalysisSummaryHandler } from "./routes/analysisSummary.js";
import { createAnalysisEventsHandler } from "./routes/analysisEvents.js";
import { createSynthesisStatusHandler, createSynthesizeHandler, createGetSynthesisHandler } from "./routes/courseSynthesis.js";
import { createEnsureWorkerRunningHandler } from "./routes/internal.js";
import { requireOperator } from "./middleware/operatorAuth.js";
import { createJobTrigger } from "../jobs/runJobTrigger.js";
import { createGoogleOidcVerifier } from "../lib/googleOidc.js";
import type { AnalyzeLessonDeps } from "../pipeline/analyzeLesson.js";

export function createApp(config: AppConfig): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(corsMiddleware(config.allowedOrigin));

  const { fetchLesson } = createWhopClient(config.whopApiBase);
  const gemini = createGeminiClient(config.geminiApiKey);
  const pool = createPool(config.db);
  const courseClient = createWhopCourseClient(config.whopApiBase);
  const oauthClient = createWhopOAuthClient(config.whopClientId);

  const deps: AnalyzeLessonDeps = {
    fetchWhopLesson: fetchLesson,
    gemini,
    geminiModel: config.geminiModel,
    geminiProcessingMode: config.geminiVideoProcessingMode,
    remux: (signedUrl, outputPath, options) =>
      remuxToMp4(signedUrl, outputPath, { ffmpegPath: config.ffmpegPath, ...options }),
    ffmpegPath: config.ffmpegPath,
  };

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Every route below requires the caller to present a bearer token that
  // verifies (via Whop's userinfo endpoint) as the same Whop account
  // already established as this deployment's single operator. CORS/Origin
  // are not, and never were, the security boundary here.
  const operatorAuth = requireOperator({ pool, oauthClient, whopOperatorUserId: config.whopOperatorUserId });

  // Preserved: the existing single-lesson analysis flow, now also gated —
  // an arbitrary caller with an arbitrary Whop token can no longer spend
  // this deployment's Gemini quota.
  app.post("/api/analyze-lesson", operatorAuth, createAnalyzeLessonHandler(deps));

  // PR2: batch analysis job control, dashboard summary, live progress, and
  // the Cloud Scheduler safety net. requireApiRoleEnv fails startup loudly
  // if any of these are missing rather than silently degrading.
  const { gcpProjectId, cloudRunJobName, schedulerServiceAccountEmail, publicApiBaseUrl } = requireApiRoleEnv(config);
  const jobTrigger = createJobTrigger({ projectId: gcpProjectId, region: config.gcpRegion, jobName: cloudRunJobName });

  const authDeps = {
    pool,
    oauthClient,
    refreshTokenEncryptionKey: config.refreshTokenEncryptionKey,
    whopOperatorUserId: config.whopOperatorUserId,
    jobTrigger,
  };
  // Not gated: this is the one route reachable before any operator exists —
  // it verifies the submitted token itself and enforces single-operator
  // ownership inline (see http/routes/auth.ts).
  app.post("/api/auth/session", createEstablishSessionHandler(authDeps));
  app.get("/api/auth/status", operatorAuth, createAuthStatusHandler(authDeps));
  app.post("/api/auth/disconnect", operatorAuth, createDisconnectHandler(authDeps));

  app.post(
    "/api/course/sync",
    operatorAuth,
    createCourseSyncHandler({ pool, courseClient, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey, course: config.course }),
  );
  app.get(
    "/api/course/lessons",
    operatorAuth,
    createCourseLessonsHandler({ pool, whopCourseId: config.course.courseId }),
  );
  app.get(
    "/api/course/lessons/:lessonId/analysis",
    operatorAuth,
    createLessonAnalysisDetailHandler({ pool }),
  );

  const analysisJobsDeps = { pool, jobTrigger, geminiModel: config.geminiModel };
  app.post("/api/analysis/jobs", operatorAuth, createEnqueueJobsHandler(analysisJobsDeps));
  app.post("/api/analysis/jobs/:jobId/retry", operatorAuth, createRetryJobHandler(analysisJobsDeps));
  app.post("/api/analysis/jobs/:jobId/cancel", operatorAuth, createCancelJobHandler(analysisJobsDeps));
  app.get("/api/analysis/jobs/:jobId", operatorAuth, createGetJobHandler(analysisJobsDeps));
  app.get(
    "/api/analysis/summary",
    operatorAuth,
    createAnalysisSummaryHandler({ pool, whopCourseId: config.course.courseId }),
  );
  app.get("/api/analysis/events", operatorAuth, createAnalysisEventsHandler({ pool }));

  // Phase 3.4: course-level strategy synthesis. Reuses the same jobTrigger
  // as lesson-analysis enqueueing (analysisJobsDeps above) — one Cloud Run
  // Job, one entrypoint, a second independent processing phase (see
  // server.ts / worker/synthesisLoop.ts). No new infrastructure.
  const courseSynthesisDeps = { pool, whopCourseId: config.course.courseId, geminiModel: config.geminiModel, jobTrigger };
  app.get("/api/course/synthesis-status", operatorAuth, createSynthesisStatusHandler(courseSynthesisDeps));
  app.post("/api/course/synthesize", operatorAuth, createSynthesizeHandler(courseSynthesisDeps));
  app.get("/api/course/synthesis", operatorAuth, createGetSynthesisHandler(courseSynthesisDeps));

  const oidcVerifier = createGoogleOidcVerifier(publicApiBaseUrl, schedulerServiceAccountEmail);
  app.post("/internal/ensure-worker-running", createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier }));

  return app;
}
