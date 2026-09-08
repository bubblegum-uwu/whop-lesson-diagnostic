import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getLessonsByIds } from "../../db/lessonsRepo.js";
import { computeAnalysisFingerprint } from "../../pipeline/fingerprint.js";
import { findLatestByFingerprint } from "../../db/lessonAnalysesRepo.js";
import { createJob, getJob, cancelIfQueued, resetForManualRetry } from "../../db/analysisJobsRepo.js";
import { getAuthSessionStatus } from "../../db/authSessionRepo.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { logger } from "../../lib/logger.js";

const WHOP_NOT_CONNECTED_RESPONSE = {
  error: {
    message: "Whop is not connected. Connect Whop from the project's Sources page to analyze new lessons.",
    type: "WHOP_NOT_CONNECTED",
  },
} as const;

/**
 * A worker's `processOneJob` (see worker/mainLoop.ts) fetches the lesson's
 * video directly from Whop via `getValidAccessToken`/`analyzeLesson` for
 * every job it actually processes — there is no path that produces a NEW
 * analysis without Whop. So any route that can create a QUEUED job the
 * worker would need to act on requires an active Whop connection, checked
 * here (not via requireWhopConnected middleware) so the enqueue route below
 * can still allow through a request that turns out to enqueue nothing (see
 * its own comment).
 */
async function isWhopConnected(pool: Pool): Promise<boolean> {
  const status = await getAuthSessionStatus(pool);
  return status?.status === "active";
}

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
 * POST /api/analysis/jobs — enqueues batch analysis for the given lessons
 * (backs both "Analyze Selected" and "Analyze All Unanalyzed"). Deduplicates
 * via the analysis fingerprint (unless `force`), creates one analysis_jobs
 * row per lesson actually queued, then triggers a Cloud Run Job execution
 * asynchronously — this handler never waits on lesson processing itself.
 *
 * Provider gating: every lesson that would actually be enqueued here is
 * fetched fresh from Whop once the worker picks up its job (see this file's
 * `isWhopConnected` doc comment) — so a request that would enqueue at least
 * one job requires an active Whop connection, checked BEFORE creating any
 * jobs (atomic: never enqueue some and reject the rest). A request whose
 * every lesson is already analyzed (the fingerprint-match "skip" case)
 * never touches Whop at all and stays available with Knovera auth alone,
 * even while disconnected — it doesn't queue anything new to process.
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

    // Pass 1 — decide skip-vs-enqueue for every lesson without creating
    // anything yet, so we know in advance whether this request needs Whop.
    const plan: { lesson: (typeof lessons)[number]; fingerprint: string; skipReason: string | null }[] = [];
    for (const lesson of lessons) {
      const fingerprint = computeAnalysisFingerprint({ whopLessonId: lesson.whopLessonId, geminiModel: deps.geminiModel });
      let skipReason: string | null = null;
      if (!force) {
        const existing = await findLatestByFingerprint(deps.pool, fingerprint);
        if (existing && (existing.status === "completed" || existing.status === "no_strategy")) {
          skipReason = "already_analyzed";
        }
      }
      plan.push({ lesson, fingerprint, skipReason });
    }

    const willEnqueueAny = plan.some((p) => p.skipReason === null);
    if (willEnqueueAny && !(await isWhopConnected(deps.pool))) {
      res.status(409).json(WHOP_NOT_CONNECTED_RESPONSE);
      return;
    }

    // Pass 2 — actually create jobs, now that we know it's safe to.
    const queued: { lessonId: number; jobId: string }[] = [];
    const skipped: { lessonId: number; reason: string }[] = [];
    for (const { lesson, fingerprint, skipReason } of plan) {
      if (skipReason) {
        skipped.push({ lessonId: lesson.id, reason: skipReason });
        continue;
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

/**
 * POST /api/analysis/jobs/:jobId/retry — only for FAILED/AUTH_REQUIRED, per
 * the approved retry model. Always requires an active Whop connection: a
 * retry unconditionally re-queues the job for the worker to fetch the
 * lesson's video from Whop again (see this file's `isWhopConnected` doc
 * comment) — unlike the enqueue route above, there is no "already analyzed"
 * skip path here, since a job only reaches FAILED/AUTH_REQUIRED after
 * failing to produce a completed analysis.
 */
export function createRetryJobHandler(deps: AnalysisJobsRouteDeps) {
  return async function retryJobHandler(req: Request, res: Response): Promise<void> {
    if (!(await isWhopConnected(deps.pool))) {
      res.status(409).json(WHOP_NOT_CONNECTED_RESPONSE);
      return;
    }
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
