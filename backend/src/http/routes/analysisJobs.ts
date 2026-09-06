import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getLessonsByIds } from "../../db/lessonsRepo.js";
import { computeAnalysisFingerprint } from "../../pipeline/fingerprint.js";
import { findLatestByFingerprint } from "../../db/lessonAnalysesRepo.js";
import { createJob, getJob, cancelIfQueued, resetForManualRetry } from "../../db/analysisJobsRepo.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { logger } from "../../lib/logger.js";

export interface AnalysisJobsRouteDeps {
  pool: Pool;
  jobTrigger: JobTrigger;
  geminiModel: string;
}

interface EnqueueBody {
  lessonIds?: number[];
  force?: boolean;
}

/**
 * POST /api/analysis/jobs — enqueues batch analysis for the given lessons.
 * Deduplicates via the analysis fingerprint (unless `force`), creates one
 * analysis_jobs row per lesson actually queued, then triggers a Cloud Run
 * Job execution asynchronously — this handler never waits on lesson
 * processing itself.
 */
export function createEnqueueJobsHandler(deps: AnalysisJobsRouteDeps) {
  return async function enqueueJobsHandler(req: Request, res: Response): Promise<void> {
    const body = req.body as EnqueueBody;
    const lessonIds = Array.isArray(body?.lessonIds) ? body.lessonIds.filter((n) => Number.isFinite(n)) : [];
    if (lessonIds.length === 0) {
      res.status(400).json({ error: { message: "Missing lessonIds.", type: "invalid_request" } });
      return;
    }
    const force = body.force === true;

    const lessons = await getLessonsByIds(deps.pool, lessonIds);
    const queued: { lessonId: number; jobId: string }[] = [];
    const skipped: { lessonId: number; reason: string }[] = [];

    for (const lesson of lessons) {
      const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: deps.geminiModel });
      if (!force) {
        const existing = await findLatestByFingerprint(deps.pool, fingerprint);
        if (existing && (existing.status === "completed" || existing.status === "no_strategy")) {
          skipped.push({ lessonId: lesson.id, reason: "already_analyzed" });
          continue;
        }
      }
      const job = await createJob(deps.pool, lesson.id, fingerprint);
      queued.push({ lessonId: lesson.id, jobId: job.jobId });
    }

    if (queued.length > 0) {
      try {
        await deps.jobTrigger.triggerRun();
      } catch (err) {
        // The jobs are already durably queued in Postgres — a failed trigger
        // call is recovered by the Cloud Scheduler safety net, not fatal here.
        logger.error("Failed to trigger worker Job execution after enqueue", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.status(202).json({ queued, skipped });
  };
}

/** POST /api/analysis/jobs/:jobId/retry — only for FAILED/AUTH_REQUIRED, per the approved retry model. */
export function createRetryJobHandler(deps: AnalysisJobsRouteDeps) {
  return async function retryJobHandler(req: Request, res: Response): Promise<void> {
    const jobId = String(req.params.jobId);
    const job = await resetForManualRetry(deps.pool, jobId);
    if (!job) {
      res.status(409).json({
        error: { message: "Job is not in a retryable state (must be FAILED or AUTH_REQUIRED).", type: "not_retryable" },
      });
      return;
    }
    try {
      await deps.jobTrigger.triggerRun();
    } catch (err) {
      logger.error("Failed to trigger worker Job execution after retry", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(202).json({ jobId: job.jobId, status: job.status });
  };
}

/** POST /api/analysis/jobs/:jobId/cancel — only while QUEUED; in-flight processing cannot be reliably cancelled (documented limitation). */
export function createCancelJobHandler(deps: AnalysisJobsRouteDeps) {
  return async function cancelJobHandler(req: Request, res: Response): Promise<void> {
    const jobId = String(req.params.jobId);
    const cancelled = await cancelIfQueued(deps.pool, jobId);
    if (!cancelled) {
      res.status(409).json({
        error: {
          message: "Job can only be cancelled while QUEUED — it may already be processing or finished.",
          type: "not_cancellable",
        },
      });
      return;
    }
    res.status(200).json({ jobId, status: "CANCELLED" });
  };
}

/** GET /api/analysis/jobs/:jobId — full job state (used by the detail view / polling fallback). */
export function createGetJobHandler(deps: AnalysisJobsRouteDeps) {
  return async function getJobHandler(req: Request, res: Response): Promise<void> {
    const job = await getJob(deps.pool, String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: { message: "Job not found.", type: "not_found" } });
      return;
    }
    res.status(200).json({ job });
  };
}
