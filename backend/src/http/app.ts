import express, { type Express } from "express";
import type { AppConfig } from "../config.js";
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
import { requireOperator } from "./middleware/operatorAuth.js";
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
  const operatorAuth = requireOperator({ pool, oauthClient });

  // Preserved: the existing single-lesson analysis flow, now also gated —
  // an arbitrary caller with an arbitrary Whop token can no longer spend
  // this deployment's Gemini quota.
  app.post("/api/analyze-lesson", operatorAuth, createAnalyzeLessonHandler(deps));

  const authDeps = { pool, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey };
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

  return app;
}
