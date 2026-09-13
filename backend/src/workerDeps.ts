import type { AppConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { createWhopClient } from "./whop/client.js";
import { createWhopOAuthClient } from "./whop/oauthClient.js";
import { createGeminiClient } from "./gemini/client.js";
import { remuxToMp4 } from "./ffmpeg/remux.js";
import type { WorkerLoopDeps } from "./worker/mainLoop.js";
import type { SynthesisWorkerDeps } from "./worker/synthesisLoop.js";
import type { ProjectSourceAnalysisWorkerDeps } from "./worker/projectSourceAnalysisLoop.js";
import type { DiscordCaptureWorkerDeps } from "./worker/discordCaptureLoop.js";

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

/**
 * Shared wiring for the Cloud Run Job's SECOND phase (course synthesis,
 * Phase 3.4) — see server.ts, which runs this after buildWorkerLoopDeps's
 * lesson-analysis loop has already drained. Deliberately builds its own
 * Pool/Gemini client rather than sharing buildWorkerLoopDeps's, so this
 * addition can never share mutable state with — or risk affecting — the
 * existing lesson-analysis wiring above.
 */
export function buildSynthesisWorkerDeps(config: AppConfig): SynthesisWorkerDeps {
  return {
    pool: createPool(config.db),
    gemini: createGeminiClient(config.geminiApiKey),
    model: config.geminiModel,
  };
}

/**
 * Phase 4H-B — shared wiring for the Cloud Run Job's THIRD phase
 * (project-source analysis, i.e. YouTube). Builds its own Pool/Gemini
 * client, same precedent as buildSynthesisWorkerDeps above, so this
 * addition can never share mutable state with the lesson-analysis or
 * synthesis wiring. Deliberately does NOT include fetchWhopLesson,
 * remux, or ffmpegPath — this phase never touches Whop or ffmpeg at all
 * (see youtube/acquireYouTubeVideo.ts).
 */
export function buildProjectSourceAnalysisWorkerDeps(config: AppConfig): ProjectSourceAnalysisWorkerDeps {
  return {
    pool: createPool(config.db),
    gemini: createGeminiClient(config.geminiApiKey),
    geminiModel: config.geminiModel,
    geminiProcessingMode: config.geminiVideoProcessingMode,
  };
}

/**
 * Phase 4K-B (revised) — shared wiring for the Cloud Run Job's FOURTH
 * phase (Discord capture). Builds its own Pool, same precedent as the
 * other phases — never shares a connection with lesson-analysis/
 * synthesis/project-source-analysis wiring. Needs no Gemini client at all
 * (capture never calls Gemini — see worker/discordCaptureLoop.ts).
 */
export function buildDiscordCaptureWorkerDeps(config: AppConfig): DiscordCaptureWorkerDeps {
  return {
    pool: createPool(config.db),
  };
}
