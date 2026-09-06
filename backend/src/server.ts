import { loadConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { buildWorkerLoopDeps, buildSynthesisWorkerDeps } from "./workerDeps.js";
import { runWorkerLoop } from "./worker/mainLoop.js";
import { runSynthesisLoop } from "./worker/synthesisLoop.js";
import { globalRedactor } from "./lib/redact.js";
import { logger } from "./lib/logger.js";

const config = loadConfig();

// Register long-lived secrets with the redactor as early as possible so
// they're never accidentally logged, even by a stray console.log elsewhere.
globalRedactor.register(config.geminiApiKey);
globalRedactor.register(config.db.password);
globalRedactor.register(config.refreshTokenEncryptionKey);

/**
 * One entrypoint, two roles, same container image — see config.ts. The
 * public Cloud Run SERVICE runs with SERVICE_ROLE=api (or unset) and starts
 * the HTTP server below. The private Cloud Run JOB (whop-lesson-gemini-worker)
 * runs with SERVICE_ROLE=worker: it mounts NO HTTP routes at all, runs the
 * claim/process loop until no eligible work remains, then exits — Cloud Run
 * Jobs are triggered via the Admin API, never invoked over HTTP.
 *
 * Course synthesis (Phase 3.4) reuses this same Job/container as a SECOND,
 * independent phase run after lesson analysis has fully drained — never
 * concurrently with it, and under its own advisory lock (see
 * worker/synthesisLoop.ts), so this line is the only change to how lesson
 * jobs are claimed/processed: none at all. A synthesis run failure is
 * already caught and persisted as a FAILED row inside
 * processOneSynthesisRun; only a catastrophic failure outside that (e.g. a
 * lost DB connection) would reach the .catch below, exactly like the
 * lesson loop above it.
 */
if (config.serviceRole === "worker") {
  runWorkerLoop(buildWorkerLoopDeps(config))
    .then(() => runSynthesisLoop(buildSynthesisWorkerDeps(config)))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Worker execution failed", { message: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
} else {
  const app = createApp(config);

  app.listen(config.port, () => {
    logger.info(`Backend listening on port ${config.port}`, {
      allowedOrigin: config.allowedOrigin,
      geminiModel: config.geminiModel,
    });
  });
}
