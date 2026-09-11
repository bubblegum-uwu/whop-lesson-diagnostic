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
import {
  createConnectWhopCourseHandler,
  createListWhopCoursesHandler,
  createRefreshWhopCourseHandler,
  createListWhopCourseLessonsHandler,
} from "./routes/whopCourses.js";
import { createCourseLessonsHandler } from "./routes/courseLessons.js";
import { createEnqueueJobsHandler, createRetryJobHandler, createCancelJobHandler, createGetJobHandler } from "./routes/analysisJobs.js";
import { createLessonAnalysisDetailHandler } from "./routes/lessonAnalysisDetail.js";
import { createAnalysisSummaryHandler } from "./routes/analysisSummary.js";
import { createAnalysisEventsHandler } from "./routes/analysisEvents.js";
import { createSynthesisStatusHandler, createSynthesizeHandler, createGetSynthesisHandler } from "./routes/courseSynthesis.js";
import { createProjectSynthesisStatusHandler, createProjectSynthesizeHandler, createGetProjectSynthesisHandler } from "./routes/projectSynthesis.js";
import { createListProjectsHandler, createGetProjectHandler, createCreateProjectHandler } from "./routes/projects.js";
import {
  createGetProjectSourcesHandler,
  createAddYouTubeSourceHandler,
  createAddDiscordSourceHandler,
  createBatchAddYouTubeSourcesHandler,
  createBatchAddDiscordSourcesHandler,
} from "./routes/projectSources.js";
import {
  createListSourceCollectionsHandler,
  createGetSourceCollectionHandler,
  createAddYouTubeCollectionHandler,
  createRefreshSourceCollectionHandler,
  createDeleteSourceCollectionHandler,
} from "./routes/sourceCollections.js";
import {
  createListSynthesisSetsHandler,
  createCreateSynthesisSetHandler,
  createGetSynthesisSetHandler,
  createUpdateSynthesisSetHandler,
  createDeleteSynthesisSetHandler,
  createAddSourceToSynthesisSetHandler,
  createRemoveSourceFromSynthesisSetHandler,
} from "./routes/synthesisSets.js";
import {
  createAnalyzeProjectSourceHandler,
  createGetProjectSourceAnalysisHandler,
  createRetryProjectSourceAnalysisHandler,
  createBatchAnalyzeProjectSourcesHandler,
} from "./routes/projectSourceAnalysis.js";
import { createGetUsageHandler } from "./routes/usage.js";
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

  // Phase 4K — multiple Whop courses per project (the source-catalog side
  // only; legacy course-scoped synthesis is untouched — see
  // http/routes/whopCourses.ts's doc comment). Same whopConnected
  // pre-check as /api/course/sync above for connect/refresh (both call
  // the live Whop API); the list/lessons reads below touch only
  // already-persisted Postgres data, so they need no such gate.
  const whopCoursesDeps = { pool, courseClient, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey };
  app.post("/api/projects/:projectId/whop-courses", knoveraAuth, whopConnected, createConnectWhopCourseHandler(whopCoursesDeps));
  app.get("/api/projects/:projectId/whop-courses", knoveraAuth, createListWhopCoursesHandler(whopCoursesDeps));
  app.post("/api/projects/:projectId/whop-courses/:courseId/refresh", knoveraAuth, whopConnected, createRefreshWhopCourseHandler(whopCoursesDeps));
  app.get("/api/projects/:projectId/whop-courses/:courseId/lessons", knoveraAuth, createListWhopCourseLessonsHandler(whopCoursesDeps));
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
  app.post("/api/projects", knoveraAuth, createCreateProjectHandler(projectsDeps));
  app.get("/api/projects/:projectId", knoveraAuth, createGetProjectHandler(projectsDeps));
  app.get("/api/projects/:projectId/sources", knoveraAuth, createGetProjectSourcesHandler(projectsDeps));
  // Phase 4H-A — storage/identity only, never Whop-gated: adding a public
  // YouTube video to a project must work whether Whop is connected or not
  // (see projectSources.ts's route doc comment). Knovera auth alone, same
  // as every other project route above.
  app.post("/api/projects/:projectId/sources/youtube", knoveraAuth, createAddYouTubeSourceHandler(projectsDeps));
  // Phase 4I — same reasoning as the YouTube route above, applied to a
  // Discord video attachment source (see projectSources.ts's route doc
  // comment).
  app.post("/api/projects/:projectId/sources/discord", knoveraAuth, createAddDiscordSourceHandler(projectsDeps));
  // Phase 4K — bulk à-la-carte import: multiple URLs in one request, each
  // independently validated/deduped/imported (see projectSources.ts's doc
  // comment on createBatchAddYouTubeSourcesHandler/
  // createBatchAddDiscordSourcesHandler). Never analyzes anything.
  app.post("/api/projects/:projectId/sources/youtube/batch", knoveraAuth, createBatchAddYouTubeSourcesHandler(projectsDeps));
  app.post("/api/projects/:projectId/sources/discord/batch", knoveraAuth, createBatchAddDiscordSourcesHandler(projectsDeps));

  // Phase 4K — the source-collection catalog layer (YouTube channels /
  // Discord collections) above project_sources. See
  // http/routes/sourceCollections.ts's doc comments — Whop deliberately
  // has no equivalent route here (a Whop course already IS a
  // project-scoped collection via courses.project_id; see the Whop routes
  // registered further below).
  const sourceCollectionsDeps = { pool };
  app.get("/api/projects/:projectId/collections", knoveraAuth, createListSourceCollectionsHandler(sourceCollectionsDeps));
  app.post("/api/projects/:projectId/collections/youtube", knoveraAuth, createAddYouTubeCollectionHandler(sourceCollectionsDeps));
  app.get("/api/projects/:projectId/collections/:collectionId", knoveraAuth, createGetSourceCollectionHandler(sourceCollectionsDeps));
  app.post("/api/projects/:projectId/collections/:collectionId/refresh", knoveraAuth, createRefreshSourceCollectionHandler(sourceCollectionsDeps));
  app.delete("/api/projects/:projectId/collections/:collectionId", knoveraAuth, createDeleteSourceCollectionHandler(sourceCollectionsDeps));

  // Phase 4H-B — project-source analysis (YouTube; Discord as of Phase 4I).
  // Same jobTrigger as lesson-analysis enqueueing (one Cloud Run Job, one
  // entrypoint, a THIRD independent processing phase — see server.ts /
  // worker/projectSourceAnalysisLoop.ts). Knovera auth only, never
  // requireWhopConnected: project-source analysis never touches Whop OAuth.
  const projectSourceAnalysisDeps = { pool, jobTrigger, geminiModel: config.geminiModel };
  app.post(
    "/api/projects/:projectId/sources/:sourceId/analyze",
    knoveraAuth,
    createAnalyzeProjectSourceHandler(projectSourceAnalysisDeps),
  );
  app.get(
    "/api/projects/:projectId/sources/:sourceId/analysis",
    knoveraAuth,
    createGetProjectSourceAnalysisHandler(projectSourceAnalysisDeps),
  );
  app.post(
    "/api/projects/:projectId/sources/:sourceId/retry",
    knoveraAuth,
    createRetryProjectSourceAnalysisHandler(projectSourceAnalysisDeps),
  );
  // Phase 4K — explicit "Analyze Selected": orchestrates the SAME per-item
  // job-creation logic as the single-item route above, over a
  // caller-supplied list of sourceIds. Never a second analysis engine.
  app.post(
    "/api/projects/:projectId/sources/analyze-batch",
    knoveraAuth,
    createBatchAnalyzeProjectSourcesHandler(projectSourceAnalysisDeps),
  );

  // Phase 4J — Synthesis Sets: a persistent, named configuration of which
  // project_sources should be considered together, and its membership.
  // Purely a configuration layer — creating a set, or adding/removing a
  // source, never analyzes anything and never touches the existing
  // synthesis engine (see http/routes/synthesisSets.ts's doc comments).
  // Knovera auth only, never requireWhopConnected — same reasoning as
  // every other project-source route above.
  app.get("/api/projects/:projectId/synthesis-sets", knoveraAuth, createListSynthesisSetsHandler(projectsDeps));
  app.post("/api/projects/:projectId/synthesis-sets", knoveraAuth, createCreateSynthesisSetHandler(projectsDeps));
  app.get("/api/projects/:projectId/synthesis-sets/:setId", knoveraAuth, createGetSynthesisSetHandler(projectsDeps));
  app.patch("/api/projects/:projectId/synthesis-sets/:setId", knoveraAuth, createUpdateSynthesisSetHandler(projectsDeps));
  app.delete("/api/projects/:projectId/synthesis-sets/:setId", knoveraAuth, createDeleteSynthesisSetHandler(projectsDeps));
  app.post("/api/projects/:projectId/synthesis-sets/:setId/sources", knoveraAuth, createAddSourceToSynthesisSetHandler(projectsDeps));
  app.delete(
    "/api/projects/:projectId/synthesis-sets/:setId/sources/:sourceId",
    knoveraAuth,
    createRemoveSourceFromSynthesisSetHandler(projectsDeps),
  );

  // Phase 4E — the project-aware counterpart to /api/course/synthesis*
  // above: resolves a project's synthesis source via `courses.project_id`
  // (never the globally configured WHOP_COURSE_ID) and otherwise delegates
  // to the exact same synthesis logic (see routes/projectSynthesis.ts and
  // the buildSynthesisStatusPayload/buildFullSynthesisPayload/
  // handleSynthesizeForCourse helpers it shares with the legacy routes).
  // Gated by Knovera auth only — reads/writes persisted data, never Whop.
  // Legacy /api/course/synthesis* routes are left intact for compatibility
  // during the migration; nothing here removes them.
  const projectSynthesisDeps = { pool, geminiModel: config.geminiModel, jobTrigger };
  app.get("/api/projects/:projectId/synthesis/status", knoveraAuth, createProjectSynthesisStatusHandler(projectSynthesisDeps));
  app.post("/api/projects/:projectId/synthesis", knoveraAuth, createProjectSynthesizeHandler(projectSynthesisDeps));
  app.get("/api/projects/:projectId/synthesis", knoveraAuth, createGetProjectSynthesisHandler(projectSynthesisDeps));

  // Phase 4F — project-aware Usage dashboard: current-month analysis +
  // synthesis spend, grouped by `courses.project_id` (see db/usageRepo.ts
  // for the exact accounting rule). Pure reads of persisted Postgres data —
  // gated by Knovera auth only, never Whop.
  app.get("/api/usage", knoveraAuth, createGetUsageHandler({ pool }));

  const oidcVerifier = createGoogleOidcVerifier(publicApiBaseUrl, schedulerServiceAccountEmail);
  app.post("/internal/ensure-worker-running", createEnsureWorkerRunningHandler({ pool, jobTrigger, oidcVerifier }));

  return app;
}
