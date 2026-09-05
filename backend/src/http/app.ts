import express, { type Express } from "express";
import type { AppConfig } from "../config.js";
import { corsMiddleware } from "../lib/cors.js";
import { createWhopClient } from "../whop/client.js";
import { createGeminiClient } from "../gemini/client.js";
import { remuxToMp4 } from "../ffmpeg/remux.js";
import { createAnalyzeLessonHandler } from "./routes/analyzeLesson.js";
import type { AnalyzeLessonDeps } from "../pipeline/analyzeLesson.js";

export function createApp(config: AppConfig): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(corsMiddleware(config.allowedOrigin));

  const { fetchLesson } = createWhopClient(config.whopApiBase);
  const gemini = createGeminiClient(config.geminiApiKey);

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

  app.post("/api/analyze-lesson", createAnalyzeLessonHandler(deps));

  return app;
}
