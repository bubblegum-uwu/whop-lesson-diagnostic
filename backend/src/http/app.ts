import express, { type Express } from "express";
import { requireApiRoleEnv, requireKnoveraAuthEnv, type AppConfig } from "../config.js";
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
import { createKnoveraLoginHandler, createKnoveraMeHandler, createKnoveraLogoutHandler } from "./routes/knoveraAuth.js";
import { createCourseSyncHandler } from "./routes/courseSync.js";
import { createCourseLessonsHandler } from "./routes/courseLessons.js";
import { createEnqueueJobsHandler, createRetryJobHandler, createCancelJobHandler, createGetJobHandler } from "./routes/analysisJobs.js";
import { createLessonAnalysisDetailHandler } from "./routes/lessonAnalysisDetail.js";
import { createAnalysisSummaryHandler } from "./routes/analysisSummary.js";
import { createAnalysisEventsHandler } from "./routes/analysisEvents.js";
import { createSynthesisStatusHandler, createSynthesizeHandler, createGetSynthesisHandler } from "./routes/courseSynthesis.js";
import { createListProjectsHandler, createGetProjectHandler } from "./routes/projects.js";
import { createGetProjectSourcesHandler } from "./routes/projectSources.js";
import { createEnsureWorkerRunningHandler } from "./routes/internal.js";
import { requireOperator } from "./middleware/operatorAuth.js";
import { requireKnoveraAuth } from "./middleware/knoveraAuth.js";
import { requireWhopConnected } from "./middleware/whopConnected.js";
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

  // Phase 4D — Knovera application login, entirely separate from Whop OAuth
  // below (see KNOVERA_AUTH_VS_PROVIDER_AUTH in the Phase 4D PR
  // description). Gates every route that only needs "is this browser
  // logged into Knovera" — which, after this phase, is nearly everything:
  // Projects, Sources, lesson/analysis reads, synthesis, and even Whop
  // connection management (status/disconnect/connect-completion) below.
  // Never calls Whop, never touches auth_sessions.
  const knoveraAuthConfig = requireKnoveraAuthEnv(config);
  const knoveraAuth = requireKnoveraAuth({ authSecret: knoveraAuthConfig.authSecret });
  const knoveraAuthDeps = { knoveraAuth: knoveraAuthConfig };
  app.post("/api/knovera-auth/login", createKnoveraLoginHandler(knoveraAuthDeps));
  app.get("/api/knovera-auth/me", knoveraAuth, createKnoveraMeHandler(knoveraAuthDeps));
  // Self-verifying (see knoveraAuth.ts route comment on why this stays
  // stateless) — no requireKnoveraAuth needed in front of it.
  app.post("/api/knovera-auth/logout", createKnoveraLogoutHandler(knoveraAuthDeps));

  // Whop OAuth: verifies a bearer token against Whop's userinfo endpoint and
  // checks it belongs to the one configured operator. After Phase 4D this is
  // used for exactly one thing: the standalone single-lesson diagnostic tool
  // below, which takes a caller-supplied, short-lived Whop token as both its
  // authorization AND its Whop-fetch credential in one call — a genuinely
  // different, bring-your-own-token model that predates (and is unrelated
  // to) both Knovera login and the persistent Whop provider connection, so
  // it is deliberately left untouched here rather than forced through
  // knoveraAuth (which would have nowhere to put the Whop token it still
  // needs to fetch the lesson).
  const operatorAuth = requireOperator({ pool, oauthClient, whopOperatorUserId: config.whopOperatorUserId });
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
  // Whop provider-connection lifecycle. All three now require Knovera login
  // (never Whop) — connecting, checking, or disconnecting Whop is something
  // you do FROM an authenticated Knovera session, not something that grants
  // one. /session still verifies the submitted Whop token itself and
  // enforces single-operator ownership inline exactly as before (see
  // http/routes/auth.ts) — requireKnoveraAuth only adds the prerequisite
  // that a real Knovera session already exists.
  app.post("/api/auth/session", knoveraAuth, createEstablishSessionHandler(authDeps));
  app.get("/api/auth/status", knoveraAuth, createAuthStatusHandler(authDeps));
  app.post("/api/auth/disconnect", knoveraAuth, createDisconnectHandler(authDeps));

  // The one course/analysis mutation that genuinely calls Whop (via the
  // stored provider connection, never the caller's own token — see
  // courseSync.ts) — requireWhopConnected is a fast pre-check; courseSync's
  // own existing getValidAccessToken/AuthRequiredError handling is
  // untouched as the fallback for "connected but refresh just failed."
  const whopConnected = requireWhopConnected({ pool });
  app.post(
    "/api/course/sync",
    knoveraAuth,
    whopConnected,
    createCourseSyncHandler({ pool, courseClient, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey, course: config.course }),
  );
  // Reads of already-persisted course/lesson data — never call Whop (see
  // courseLessons.ts / lessonAnalysisDetail.ts: both read Postgres only).
  // Whop being disconnected must never hide content that already exists.
  app.get(
    "/api/course/lessons",
    knoveraAuth,
    createCourseLessonsHandler({ pool, whopCourseId: config.course.courseId }),
  );
  app.get(
    "/api/course/lessons/:lessonId/analysis",
    knoveraAuth,
    createLessonAnalysisDetailHandler({ pool }),
  );

  // Enqueue/retry/cancel/get only ever write analysis_jobs rows and trigger
  // the worker Job asynchronously — none of these handlers call Whop (see
  // analysisJobs.ts). The worker process that later actually processes a
  // queued job fetches its OWN Whop access token from the stored provider
  // connection (worker/mainLoop.ts's getValidAccessToken) at that later
  // time — if Whop is disconnected by then, the job surfaces as
  // AUTH_REQUIRED through existing, unchanged job-status handling, not as a
  // failure of these routes.
  const analysisJobsDeps = { pool, jobTrigger, geminiModel: config.geminiModel };
  app.post("/api/analysis/jobs", knoveraAuth, createEnqueueJobsHandler(analysisJobsDeps));
  app.post("/api/analysis/jobs/:jobId/retry", knoveraAuth, createRetryJobHandler(analysisJobsDeps));
  app.post("/api/analysis/jobs/:jobId/cancel", knoveraAuth, createCancelJobHandler(analysisJobsDeps));
  app.get("/api/analysis/jobs/:jobId", knoveraAuth, createGetJobHandler(analysisJobsDeps));
  app.get(
    "/api/analysis/summary",
    knoveraAuth,
    createAnalysisSummaryHandler({ pool, whopCourseId: config.course.courseId }),
  );
  app.get("/api/analysis/events", knoveraAuth, createAnalysisEventsHandler({ pool }));

  // Phase 3.4/3.5B: course-level strategy synthesis. courseSynthesis.ts uses
  // whopCourseId only as a stable string identifier to look up the course
  // row — it never calls Whop's API, so reading or launching synthesis
  // never requires an active Whop connection, only Knovera login. Reuses
  // the same jobTrigger as lesson-analysis enqueueing above — one Cloud Run
  // Job, one entrypoint, a second independent processing phase (see
  // server.ts / worker/synthesisLoop.ts). No new infrastructure.
  const courseSynthesisDeps = { pool, whopCourseId: config.course.courseId, geminiModel: config.geminiModel, jobTrigger };
  app.get("/api/course/synthesis-status", knoveraAuth, createSynthesisStatusHandler(courseSynthesisDeps));
  app.post("/api/course/synthesize", knoveraAuth, createSynthesizeHandler(courseSynthesisDeps));
  app.get("/api/course/synthesis", knoveraAuth, createGetSynthesisHandler(courseSynthesisDeps));

  // Phase 4B/4C: the Knovera project layer — pure reads of persisted
  // project/course/lesson data, gated by Knovera login only (this is the
  // whole point of Phase 4D: Projects must be visible with Whop
  // disconnected). Does not reparameterize /api/course/*, /api/analysis/*,
  // or /api/course/synthesis*, which keep operating on
  // config.course.courseId exactly as before.
  const projectsDeps = { pool };
  app.get("/api/projects", knoveraAuth, createListProjectsHandler(projectsDeps));
  app.get("/api/projects/:projectId", knoveraAuth, createGetProjectHandler(projectsDeps));
  app.get("/api/projects/:projectId/sources", knoveraAuth, createGetProjectSourcesHandler(projectsDeps));

  const oidcVerifier = createGoogleOidcVerifier(publicApiBaseUrl, schedulerServiceAccountEmail);
  app.post("/internal/ensure-worker-running", createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier }));

  return app;
}
