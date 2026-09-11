import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getProjectSourceById, ANALYZABLE_PROJECT_SOURCE_PROVIDERS } from "../../db/projectSourcesRepo.js";
import {
  createJob,
  getLatestJobForProjectSource,
  resetForManualRetry,
  PROJECT_SOURCE_ANALYSIS_TERMINAL_STATUSES,
} from "../../db/projectSourceAnalysisJobsRepo.js";
import { findLatestByFingerprint } from "../../db/projectSourceAnalysesRepo.js";
import { computeProjectSourceAnalysisFingerprint } from "../../pipeline/fingerprint.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { logger } from "../../lib/logger.js";

export interface ProjectSourceAnalysisRouteDeps {
  pool: Pool;
  jobTrigger: JobTrigger;
  geminiModel: string;
}

const NOT_FOUND_RESPONSE = {
  error: { message: "Unknown project source.", type: "project_source_not_found" },
} as const;

/**
 * Every route below enforces ownership the same way: the source must exist
 * AND belong to the requested project. Deliberately never trusts sourceId
 * alone — see the Phase 4H-B PR description's ownership-validation rule.
 * Returns the same deterministic 404 whether the project is unknown, the
 * source is unknown, or the source belongs to a DIFFERENT project — never
 * leaking which case it was.
 */
async function resolveOwnedSource(pool: Pool, projectIdParam: string | string[], sourceIdParam: string | string[]) {
  const projectId = Number(projectIdParam);
  const sourceId = Number(sourceIdParam);
  if (!Number.isInteger(projectId) || !Number.isInteger(sourceId)) return null;

  const project = await getProjectById(pool, projectId);
  if (!project) return null;

  const source = await getProjectSourceById(pool, sourceId);
  if (!source || source.projectId !== projectId) return null;

  return { project, source };
}

interface AnalyzeBody {
  force?: unknown;
}

/**
 * POST /api/projects/:projectId/sources/:sourceId/analyze — Phase 4H-B.
 * Knovera auth only (wired in http/app.ts) — never requireWhopConnected;
 * Whop's connection state is irrelevant to YouTube analysis (see
 * youtube/acquireYouTubeVideo.ts, which never touches Whop OAuth).
 *
 * Idempotent by construction: a non-terminal job already in flight for this
 * source is returned as-is (never a second parallel job); an existing
 * COMPLETED/NO_STRATEGY analysis under the current fingerprint is returned
 * directly unless `force` is set. Only TRADING_STRATEGIES projects may
 * analyze — General Knowledge sources stay storable/listed (Phase 4H-A)
 * without ever invoking the Trading Strategies extraction prompts.
 */
export function createAnalyzeProjectSourceHandler(deps: ProjectSourceAnalysisRouteDeps) {
  return async function analyzeProjectSourceHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSource(deps.pool, req.params.projectId, req.params.sourceId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { project, source } = resolved;

    if (!ANALYZABLE_PROJECT_SOURCE_PROVIDERS.has(source.provider)) {
      res.status(400).json({ error: { message: "This source's provider does not support analysis yet.", type: "unsupported_provider" } });
      return;
    }
    if (project.projectType !== "TRADING_STRATEGIES") {
      res.status(400).json({
        error: {
          message: "Analysis is only available for Trading Strategies projects right now.",
          type: "analysis_not_available_for_project_type",
        },
      });
      return;
    }

    const body = req.body as AnalyzeBody;
    const force = body?.force === true;

    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: deps.geminiModel });

    if (!force) {
      const existingAnalysis = await findLatestByFingerprint(deps.pool, fingerprint);
      if (existingAnalysis && (existingAnalysis.status === "completed" || existingAnalysis.status === "no_strategy")) {
        res.status(200).json({ skipped: true, analysis: existingAnalysis });
        return;
      }
    }

    const latestJob = await getLatestJobForProjectSource(deps.pool, source.id);
    if (latestJob && !PROJECT_SOURCE_ANALYSIS_TERMINAL_STATUSES.includes(latestJob.status)) {
      // Idempotent no-op: a repeated Analyze click while a job is already
      // in flight never creates a parallel duplicate job.
      res.status(202).json({ alreadyQueued: true, job: latestJob });
      return;
    }

    const job = await createJob(deps.pool, source.id, fingerprint);
    try {
      await deps.jobTrigger.triggerRun();
    } catch (err) {
      // The job is already durably queued in Postgres — a failed trigger
      // call is recovered by the Cloud Scheduler safety net, not fatal here
      // (same pattern as http/routes/analysisJobs.ts's enqueue handler).
      logger.error("Failed to trigger worker Job execution after project-source analyze", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(202).json({ alreadyQueued: false, job });
  };
}

/** GET /api/projects/:projectId/sources/:sourceId/analysis — the combined status/result view: latest job (if any) + latest persisted analysis (if any). Pure read, never calls Gemini. */
export function createGetProjectSourceAnalysisHandler(deps: ProjectSourceAnalysisRouteDeps) {
  return async function getProjectSourceAnalysisHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSource(deps.pool, req.params.projectId, req.params.sourceId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { source } = resolved;

    const [job, analysis] = await Promise.all([
      getLatestJobForProjectSource(deps.pool, source.id),
      // Reads whatever the most recently COMPLETED job's result was, via
      // fingerprint — not necessarily the same row as `job` above (job may
      // be a newer, still-in-flight re-analyze attempt).
      (async () => {
        const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: deps.geminiModel });
        return findLatestByFingerprint(deps.pool, fingerprint);
      })(),
    ]);

    res.status(200).json({ sourceId: source.id, job, analysis });
  };
}

/** POST /api/projects/:projectId/sources/:sourceId/retry — only for the source's latest job while FAILED, per the approved retry model (mirrors POST /api/analysis/jobs/:jobId/retry). */
export function createRetryProjectSourceAnalysisHandler(deps: ProjectSourceAnalysisRouteDeps) {
  return async function retryProjectSourceAnalysisHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSource(deps.pool, req.params.projectId, req.params.sourceId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const { source } = resolved;

    const latestJob = await getLatestJobForProjectSource(deps.pool, source.id);
    if (!latestJob || latestJob.status !== "FAILED") {
      res.status(409).json({
        error: { message: "This source's latest analysis is not in a retryable state (must be FAILED).", type: "not_retryable" },
      });
      return;
    }

    const job = await resetForManualRetry(deps.pool, latestJob.jobId);
    if (!job) {
      res.status(409).json({
        error: { message: "This source's latest analysis is not in a retryable state (must be FAILED).", type: "not_retryable" },
      });
      return;
    }
    try {
      await deps.jobTrigger.triggerRun();
    } catch (err) {
      logger.error("Failed to trigger worker Job execution after project-source retry", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(202).json({ job });
  };
}
