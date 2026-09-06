import type { AppConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createWhopClient } from "./whop/client.js";
import { createWhopOAuthClient } from "./whop/oauthClient.js";
import { createGeminiClient } from "./gemini/client.js";
import { remuxToMp4 } from "./ffmpeg/remux.js";
import type { WorkerLoopDeps } from "./worker/mainLoop.js";

/** Shared wiring for the Cloud Run Job entrypoint (SERVICE_ROLE=worker) — no HTTP routes are ever mounted here. */
export function buildWorkerLoopDeps(config: AppConfig): WorkerLoopDeps {
  const { fetchLesson } = createWhopClient(config.whopApiBase);
  const gemini = createGeminiClient(config.geminiApiKey);
  const pool = createPool(config.db);
  const oauthClient = createWhopOAuthClient(config.whopClientId);

  return {
    pool,
    oauthClient,
    refreshTokenEncryptionKey: config.refreshTokenEncryptionKey,
    pipelineDeps: {
      fetchWhopLesson: fetchLesson,
      gemini,
      geminiModel: config.geminiModel,
      geminiProcessingMode: config.geminiVideoProcessingMode,
      remux: (signedUrl, outputPath, options) =>
        remuxToMp4(signedUrl, outputPath, { ffmpegPath: config.ffmpegPath, ...options }),
      ffmpegPath: config.ffmpegPath,
    },
  };
}
