import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { acquireWorkerLock } from "./advisoryLock.js";
import { startHeartbeat } from "./heartbeat.js";
import {
  claimNextEligibleJob,
  renewLease,
  markSucceeded,
  markForRetry,
  markFailed,
  markAuthRequired,
  type AnalysisJob,
  type JobStatus,
} from "../db/analysisJobsRepo.js";
import { recordJobEvent } from "../db/jobEventsRepo.js";
import { createLessonAnalysis, findLatestByFingerprint } from "../db/lessonAnalysesRepo.js";
import { createStrategyInstances } from "../db/strategyInstancesRepo.js";
import { createUsageRecord } from "../db/usageRecordsRepo.js";
import { getLessonById, updateDurationSeconds } from "../db/lessonsRepo.js";
import { getValidAccessToken, AuthRequiredError } from "../whop/sessionService.js";
import type { WhopOAuthClient } from "../whop/oauthClient.js";
import { analyzeLesson, type AnalyzeLessonDeps, type PipelineStage } from "../pipeline/analyzeLesson.js";
import { buildAnalysisSummary } from "../pipeline/analysisSummary.js";
import { classifyError, computeNextRetryAt } from "../pipeline/errorClassification.js";
import { PROMPT_VERSION, SCHEMA_VERSION, EXTRACTOR_VERSION } from "../pipeline/analysisVersion.js";
import { estimateCost, CURRENT_PRICING } from "../pricing/geminiPricing.js";
import { globalRedactor, type SecretRedactor } from "../lib/redact.js";
import { logger as defaultLogger, type SafeLogger } from "../lib/logger.js";

export interface WorkerLoopDeps {
  pool: Pool;
  oauthClient: WhopOAuthClient;
  refreshTokenEncryptionKey: string;
  pipelineDeps: Omit<AnalyzeLessonDeps, "onProgress" | "onDurationDiscovered">;
  redactor?: SecretRedactor;
  logger?: SafeLogger;
  /** Overridable only for tests — production always uses the default. */
  heartbeatIntervalMs?: number;
}

const STAGE_TO_JOB_STATUS: Record<PipelineStage, JobStatus> = {
  retrieving_lesson: "RETRIEVING",
  resolving_secure_video: "RETRIEVING",
  preparing_video: "PREPARING_VIDEO",
  uploading_to_gemini: "UPLOADING",
  gemini_processing: "GEMINI_PROCESSING",
  analyzing_lesson: "ANALYZING",
  validating_result: "VALIDATING",
};

/** Both the ffmpeg-progress throttle and the independent heartbeat timer tick on this cadence — "approximately every 10 seconds" per the lease design. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** Thrown internally when a lease-fenced update finds this execution has been reclaimed; the caller aborts processing immediately without persisting anything. */
class LeaseLostError extends Error {
  constructor() {
    super("Lease was reclaimed by another worker execution.");
    this.name = "LeaseLostError";
  }
}

async function processOneJob(job: AnalysisJob, leaseOwner: string, deps: WorkerLoopDeps): Promise<void> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;

  const lesson = await getLessonById(deps.pool, job.lessonId);
  if (!lesson) {
    await markFailed(deps.pool, job.jobId, leaseOwner, "permanent", "Lesson no longer exists.");
    return;
  }

  // Idempotency: an identical successful analysis may already exist (e.g. a
  // second job was queued for the same lesson before this one was claimed).
  // Never spend a Gemini call re-deriving it.
  const existing = await findLatestByFingerprint(deps.pool, job.analysisFingerprint);
  if (existing && (existing.status === "completed" || existing.status === "no_strategy")) {
    const succeeded = await markSucceeded(
      deps.pool,
      job.jobId,
      leaseOwner,
      existing.status === "completed" ? "COMPLETED" : "NO_STRATEGY",
    );
    if (succeeded) {
      await recordJobEvent(deps.pool, job.jobId, {
        eventType: "stage_change",
        message: "Skipped — an identical successful analysis already exists.",
      });
    }
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(deps.pool, deps.oauthClient, deps.refreshTokenEncryptionKey);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      await markAuthRequired(deps.pool, job.jobId, leaseOwner);
      return;
    }
    throw err;
  }
  redactor.register(accessToken);

  let lastProgressHeartbeatAt = 0;
  let leaseLost = false;

  // A FIFO queue, not a skip-if-busy guard: stage/progress changes from the
  // pipeline carry real content (status, current_stage, progress) and must
  // never be silently dropped just because a periodic heartbeat ping is
  // already in flight. Two `renewLease` calls fired back-to-back on
  // different pooled connections can otherwise complete out of order (the
  // DB only serializes the row lock, not the order UPDATEs were issued in),
  // which could let an earlier, slower write clobber a later one's status.
  // Chaining every call through one promise guarantees they land in
  // invocation order, one at a time — which also satisfies "never run two
  // renewals concurrently" for the periodic heartbeat ticks specifically.
  let renewChain: Promise<boolean> = Promise.resolve(true);
  function renewNow(update: Parameters<typeof renewLease>[3]): Promise<boolean> {
    const next = renewChain.then(async () => {
      if (leaseLost) return false;
      const ok = await renewLease(deps.pool, job.jobId, leaseOwner, update);
      if (!ok) leaseLost = true;
      return ok;
    });
    renewChain = next.catch(() => false);
    return next;
  }

  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  // Keeps the lease/heartbeat alive independently of any pipeline callback —
  // required because a single long-awaited operation (a Gemini analysis
  // call, a file-processing poll, an upload) produces no progress event of
  // its own for minutes at a time. Started as soon as real work begins;
  // always stopped in the `finally` below, so it can never leak into the
  // next claimed lesson.
  const heartbeat = startHeartbeat({
    intervalMs: heartbeatIntervalMs,
    renew: () => renewNow({}),
  });

  const startedAt = new Date();
  const pipelineDeps: AnalyzeLessonDeps = {
    ...deps.pipelineDeps,
    onDurationDiscovered: (seconds) => {
      updateDurationSeconds(deps.pool, lesson.id, seconds).catch(() => undefined);
    },
    onProgress: (progress) => {
      const now = Date.now();
      if (now - lastProgressHeartbeatAt < heartbeatIntervalMs) return;
      lastProgressHeartbeatAt = now;
      const stageProgress =
        progress.totalSeconds && progress.totalSeconds > 0
          ? Math.min(100, Math.round((progress.elapsedSeconds / progress.totalSeconds) * 100))
          : null;
      void renewNow({ status: "PREPARING_VIDEO", stageProgress, overallProgress: stageProgress });
    },
  };

  try {
    let lastStage: PipelineStage | null = null;
    const result = await analyzeLesson(lesson.sourceUrl, accessToken, pipelineDeps, (stage) => {
      lastStage = stage;
      const jobStatus = STAGE_TO_JOB_STATUS[stage];
      void renewNow({ status: jobStatus, currentStage: stage, stageProgress: null });
      recordJobEvent(deps.pool, job.jobId, { eventType: "stage_change", stage, message: null }).catch(() => undefined);
    });
    void lastStage;

    if (leaseLost) throw new LeaseLostError();

    const completedAt = new Date();
    const status: "completed" | "no_strategy" = result.analysis.strategy_found ? "completed" : "no_strategy";
    const estimatedCost = estimateCost({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      thinkingTokens: result.usage.thinkingTokens,
    });

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const analysis = await createLessonAnalysis(client, {
        lessonId: lesson.id,
        jobId: job.jobId,
        status,
        strategyFound: result.analysis.strategy_found,
        validatedJson: result.analysis,
        analysisSummary: buildAnalysisSummary(result.analysis),
        model: deps.pipelineDeps.geminiModel,
        promptVersion: PROMPT_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        schemaVersion: SCHEMA_VERSION,
        analysisFingerprint: job.analysisFingerprint,
        startedAt,
        completedAt,
        processingDurationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        thinkingTokens: result.usage.thinkingTokens,
        estimatedCost,
      });
      if (result.analysis.strategy_found) {
        await createStrategyInstances(client, analysis.analysisId, lesson.id, result.analysis.strategies);
      }
      await createUsageRecord(client, {
        analysisId: analysis.analysisId,
        model: deps.pipelineDeps.geminiModel,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        thinkingTokens: result.usage.thinkingTokens,
        videoDurationSeconds: result.analysis.lesson.duration_seconds,
        estimatedCost,
        pricingVersion: CURRENT_PRICING.version,
        processingDurationSeconds: Math.round((completedAt.getTime() - startedAt.getTime()) / 1000),
      });

      // The final fenced check: if this execution's lease was reclaimed at
      // any point, this returns false and we roll back everything above —
      // a lease-lost worker must never persist a result.
      const succeeded = await markSucceeded(
        client,
        job.jobId,
        leaseOwner,
        status === "completed" ? "COMPLETED" : "NO_STRATEGY",
      );
      if (!succeeded) {
        await client.query("ROLLBACK");
        log.warn("Discarding analysis result — lease was reclaimed before completion.", { jobId: job.jobId });
        return;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err instanceof LeaseLostError) {
      log.warn("Abandoning job — lease was reclaimed mid-processing.", { jobId: job.jobId });
      return;
    }
    const classification = classifyError(err);
    const sanitizedMessage = redactor.redact(err instanceof Error ? err.message : "Unknown worker error.");
    log.error("Lesson analysis job failed", { jobId: job.jobId, classification, message: sanitizedMessage });

    if (classification === "auth_required") {
      await markAuthRequired(deps.pool, job.jobId, leaseOwner);
    } else if (classification === "transient") {
      await markForRetry(
        deps.pool,
        job.jobId,
        leaseOwner,
        computeNextRetryAt(job.attemptCount),
        "transient",
        sanitizedMessage,
      );
    } else {
      await markFailed(deps.pool, job.jobId, leaseOwner, "permanent", sanitizedMessage);
    }
  } finally {
    // Guaranteed on every exit path — success, lease-lost abandonment, and
    // every failure classification — so a timer can never leak into the
    // next claimed lesson.
    heartbeat.stop();
  }
}

/**
 * The Cloud Run Job's entrypoint body. Claims and processes eligible jobs
 * one at a time until none remain, then returns (the process then exits 0).
 * Never busy-loops or sleeps waiting for a future next_retry_at — a job
 * that isn't due yet simply isn't "eligible" and is left for a later
 * execution (see analysisJobsRepo.claimNextEligibleJob and the Cloud
 * Scheduler safety net in http/routes/internal.ts).
 */
export async function runWorkerLoop(deps: WorkerLoopDeps): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const lock = await acquireWorkerLock(deps.pool);
  if (!lock.acquired) {
    log.info("Another worker execution already holds the lock — exiting.", {});
    return;
  }

  const leaseOwner = `${process.env.CLOUD_RUN_EXECUTION ?? "local"}:${process.env.CLOUD_RUN_TASK_INDEX ?? "0"}:${randomUUID()}`;

  try {
    for (;;) {
      const job = await claimNextEligibleJob(deps.pool, leaseOwner);
      if (!job) break;
      log.info("Claimed analysis job", { jobId: job.jobId, lessonId: job.lessonId });
      await processOneJob(job, leaseOwner, deps);
    }
    log.info("No more eligible work — worker execution exiting.", {});
  } finally {
    await lock.release();
  }
}
