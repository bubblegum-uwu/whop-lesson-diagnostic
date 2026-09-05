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

  // Preserved, unmodified: the existing single-lesson analysis flow.
  app.post("/api/analyze-lesson", createAnalyzeLessonHandler(deps));

  const authDeps = { pool, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey };
  app.post("/api/auth/session", createEstablishSessionHandler(authDeps));
  app.get("/api/auth/status", createAuthStatusHandler(authDeps));
  app.post("/api/auth/disconnect", createDisconnectHandler(authDeps));

  app.post(
    "/api/course/sync",
    createCourseSyncHandler({ pool, courseClient, oauthClient, refreshTokenEncryptionKey: config.refreshTokenEncryptionKey, course: config.course }),
  );
  app.get("/api/course/lessons", createCourseLessonsHandler({ pool, whopCourseId: config.course.courseId }));

  return app;
}
