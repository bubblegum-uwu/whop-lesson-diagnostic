import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getProjectById } from "../../db/projectsRepo.js";
import { getProjectSourceById, listProjectSourceIdsByCollectionId, ANALYZABLE_PROJECT_SOURCE_PROVIDERS } from "../../db/projectSourcesRepo.js";
import { getSourceCollectionById } from "../../db/sourceCollectionsRepo.js";
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

    // Live-validation Fix 4 — `force` is persisted ON the job itself, not
    // just used to decide whether to reach this line: the worker needs it
    // to know this specific episode must bypass its own fingerprint-based
    // idempotency short-circuit (see worker/projectSourceAnalysisLoop.ts).
    const job = await createJob(deps.pool, source.id, fingerprint, force);
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

interface BatchAnalyzeBody {
  sourceIds?: unknown;
}

export type BatchAnalyzeResultKind = "queued" | "already_queued" | "skipped" | "not_found" | "not_analyzable";
export interface BatchAnalyzeResultEntry {
  sourceId: number;
  kind: BatchAnalyzeResultKind;
  /** Phase 4L — the in-flight job's own status when kind is "already_queued" (e.g. distinguishing QUEUED from ANALYZING/VALIDATING) — additive, existing consumers of this shape never read it. */
  jobStatus?: string;
}

const MAX_BATCH_ANALYZE_SOURCES = 50;

/**
 * Phase 4L — the ONE per-source queue-or-skip decision engine, shared by
 * the caller-supplied-list batch handler below AND the collection-scoped
 * handler further down: same idempotent no-op if already queued, same
 * skip-if-already-successfully-analyzed unless `force`, same
 * fingerprint/job-creation calls. A collection can hold far more than
 * MAX_BATCH_ANALYZE_SOURCES items — this function itself enforces no such
 * cap, because it is only ever called with a server-RESOLVED id list
 * (either the caller's own already-length-checked array, or a collection's
 * real membership), never an unbounded caller-controlled string.
 */
async function queueAnalysisForSources(
  deps: ProjectSourceAnalysisRouteDeps,
  projectId: number,
  sourceIds: number[],
  force: boolean,
): Promise<{ entries: BatchAnalyzeResultEntry[]; anyQueued: boolean }> {
  const entries: BatchAnalyzeResultEntry[] = [];
  let anyQueued = false;

  for (const sourceId of sourceIds) {
    const source = await getProjectSourceById(deps.pool, sourceId);
    if (!source || source.projectId !== projectId) {
      entries.push({ sourceId, kind: "not_found" });
      continue;
    }
    if (!ANALYZABLE_PROJECT_SOURCE_PROVIDERS.has(source.provider)) {
      entries.push({ sourceId, kind: "not_analyzable" });
      continue;
    }

    const fingerprint = computeProjectSourceAnalysisFingerprint({ projectSourceId: source.id, geminiModel: deps.geminiModel });
    if (!force) {
      const existingAnalysis = await findLatestByFingerprint(deps.pool, fingerprint);
      if (existingAnalysis && (existingAnalysis.status === "completed" || existingAnalysis.status === "no_strategy")) {
        entries.push({ sourceId, kind: "skipped" });
        continue;
      }
    }

    const latestJob = await getLatestJobForProjectSource(deps.pool, source.id);
    if (latestJob && !PROJECT_SOURCE_ANALYSIS_TERMINAL_STATUSES.includes(latestJob.status)) {
      entries.push({ sourceId, kind: "already_queued", jobStatus: latestJob.status });
      continue;
    }

    await createJob(deps.pool, source.id, fingerprint, force);
    anyQueued = true;
    entries.push({ sourceId, kind: "queued" });
  }

  return { entries, anyQueued };
}

async function triggerWorkerBestEffort(deps: ProjectSourceAnalysisRouteDeps, context: string): Promise<void> {
  try {
    await deps.jobTrigger.triggerRun();
  } catch (err) {
    logger.error(`Failed to trigger worker Job execution after ${context}`, {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * POST /api/projects/:projectId/sources/analyze-batch — Phase 4K. An
 * explicit, user-initiated "Analyze Selected" over a caller-supplied list
 * of project_source ids (spec section 30: only the sources the user
 * checked are ever enqueued — never a whole collection). This is
 * orchestration ONLY: every per-source decision (idempotent no-op if
 * already queued, skip-if-already-analyzed unless the caller asked for
 * `force`, fingerprint computation, job creation) is the EXACT same logic
 * createAnalyzeProjectSourceHandler already uses — reusing the same
 * repo functions (createJob/getLatestJobForProjectSource/
 * findLatestByFingerprint), never a second/parallel analysis engine. The
 * worker is triggered ONCE after the whole batch is queued, not once per
 * source — the trigger just wakes the same existing claim loop, which
 * drains every queued job regardless of how many woke it.
 *
 * A source that doesn't exist, belongs to another project, or isn't an
 * analyzable provider is reported per-entry (never silently dropped, never
 * failing the whole batch) — mirrors the batch source-import handlers'
 * own partial-success shape (projectSources.ts).
 */
export function createBatchAnalyzeProjectSourcesHandler(deps: ProjectSourceAnalysisRouteDeps) {
  return async function batchAnalyzeProjectSourcesHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    if (!Number.isInteger(projectId)) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(NOT_FOUND_RESPONSE);
      return;
    }

    const body = req.body as BatchAnalyzeBody;
    if (!Array.isArray(body?.sourceIds) || body.sourceIds.length === 0) {
      res.status(400).json({ error: { message: "sourceIds must be a non-empty array.", type: "invalid_request" } });
      return;
    }
    if (body.sourceIds.length > MAX_BATCH_ANALYZE_SOURCES) {
      res.status(400).json({ error: { message: `At most ${MAX_BATCH_ANALYZE_SOURCES} sources per batch.`, type: "invalid_request" } });
      return;
    }
    if (!body.sourceIds.every((id): id is number => typeof id === "number" && Number.isInteger(id))) {
      res.status(400).json({ error: { message: "Every entry in sourceIds must be an integer.", type: "invalid_request" } });
      return;
    }

    if (project.projectType !== "TRADING_STRATEGIES") {
      res.status(400).json({
        error: { message: "Analysis is only available for Trading Strategies projects right now.", type: "analysis_not_available_for_project_type" },
      });
      return;
    }

    const force = (req.body as { force?: unknown })?.force === true;
    const { entries, anyQueued } = await queueAnalysisForSources(deps, projectId, body.sourceIds, force);
    if (anyQueued) await triggerWorkerBestEffort(deps, "batch project-source analyze");

    // Strip the internal jobStatus field — this endpoint's wire shape is
    // unchanged from before Phase 4L (existing frontend/tests depend on it).
    const results: BatchAnalyzeResultEntry[] = entries.map(({ sourceId, kind }) => ({ sourceId, kind }));
    res.status(202).json({ results });
  };
}

export interface AnalyzeCollectionResult {
  queued: number;
  alreadyAnalyzed: number;
  alreadyQueued: number;
  processing: number;
  failed: number;
}

const PROCESSING_JOB_STATUSES = new Set(["ANALYZING", "VALIDATING"]);
const COLLECTION_NOT_FOUND_RESPONSE = { error: { message: "Unknown source collection.", type: "collection_not_found" } } as const;

/**
 * POST /api/projects/:projectId/collections/:collectionId/analyze — Phase
 * 4L's "Analyze Collection" / "Analyze N Remaining". Unlike
 * analyze-batch above, the source ids are resolved SERVER-SIDE from the
 * collection's real membership (listProjectSourceIdsByCollectionId) —
 * never a caller-supplied list, and never capped at
 * MAX_BATCH_ANALYZE_SOURCES since a channel can hold hundreds of videos.
 * Reuses the exact same queueAnalysisForSources engine as every other
 * analyze route — never a second/parallel analysis pipeline, never a
 * force-reanalyze (an already-successfully-analyzed source is always
 * reported under `alreadyAnalyzed`, never silently re-queued). This is
 * ANALYSIS only: it never creates, modifies, or reads Synthesis Set
 * membership — analyzing a collection never selects it into synthesis.
 */
export function createAnalyzeCollectionHandler(deps: ProjectSourceAnalysisRouteDeps) {
  return async function analyzeCollectionHandler(req: Request, res: Response): Promise<void> {
    const projectId = Number(req.params.projectId);
    const collectionId = Number(req.params.collectionId);
    if (!Number.isInteger(projectId) || !Number.isInteger(collectionId)) {
      res.status(404).json(COLLECTION_NOT_FOUND_RESPONSE);
      return;
    }
    const project = await getProjectById(deps.pool, projectId);
    if (!project) {
      res.status(404).json(COLLECTION_NOT_FOUND_RESPONSE);
      return;
    }
    const collection = await getSourceCollectionById(deps.pool, collectionId);
    if (!collection || collection.projectId !== projectId) {
      res.status(404).json(COLLECTION_NOT_FOUND_RESPONSE);
      return;
    }
    if (project.projectType !== "TRADING_STRATEGIES") {
      res.status(400).json({
        error: { message: "Analysis is only available for Trading Strategies projects right now.", type: "analysis_not_available_for_project_type" },
      });
      return;
    }

    const sourceIds = await listProjectSourceIdsByCollectionId(deps.pool, collectionId);
    const { entries, anyQueued } = await queueAnalysisForSources(deps, projectId, sourceIds, false);
    if (anyQueued) await triggerWorkerBestEffort(deps, "collection analyze");

    const result: AnalyzeCollectionResult = { queued: 0, alreadyAnalyzed: 0, alreadyQueued: 0, processing: 0, failed: 0 };
    for (const entry of entries) {
      switch (entry.kind) {
        case "queued":
          result.queued++;
          break;
        case "skipped":
          result.alreadyAnalyzed++;
          break;
        case "already_queued":
          if (entry.jobStatus && PROCESSING_JOB_STATUSES.has(entry.jobStatus)) result.processing++;
          else result.alreadyQueued++;
          break;
        case "not_found":
        case "not_analyzable":
          result.failed++;
          break;
      }
    }
    res.status(200).json(result);
  };
}
