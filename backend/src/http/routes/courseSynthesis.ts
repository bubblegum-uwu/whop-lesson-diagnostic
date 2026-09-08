import type { Request, Response } from "express";
import type { Pool } from "pg";
import { getCourseByWhopId } from "../../db/coursesRepo.js";
import { listLessons } from "../../db/lessonsRepo.js";
import { getSummaryCounts } from "../../db/analysisJobsRepo.js";
import { getLatestByLessons } from "../../db/lessonAnalysesRepo.js";
import { createSynthesisRun, getLatestCompletedRun, getLatestRun, type SynthesisRun } from "../../db/synthesisRunsRepo.js";
import { listStrategyClustersByRun } from "../../db/strategyClustersRepo.js";
import { listCanonicalStrategiesByRun } from "../../db/canonicalStrategiesRepo.js";
import { getCoursePlaybookByRun } from "../../db/coursePlaybooksRepo.js";
import { computeSourceAnalysisHash } from "../../synthesis/fingerprint.js";
import { SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SCHEMA_VERSION, SYNTHESIZER_VERSION } from "../../synthesis/version.js";
import { computeSynthesisProgress, computeHeartbeatTier } from "../../synthesis/progress.js";
import { computeSynthesisPreflight } from "../../synthesis/preflight.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { logger } from "../../lib/logger.js";

export interface CourseSynthesisRouteDeps {
  pool: Pool;
  whopCourseId: string;
  geminiModel: string;
  jobTrigger: JobTrigger;
}

/**
 * Phase 4E — narrowed from the full `CourseSynthesisRouteDeps` to exactly
 * the two fields this (and the other extracted helpers below) actually
 * use. This is what lets `http/routes/projectSynthesis.ts` call the same
 * functions with its own `ProjectSynthesisRouteDeps` (which has no
 * `whopCourseId` — a project resolves its course via ownership, never a
 * globally configured id) without restating any synthesis logic.
 */
interface SynthesisCoreDeps {
  pool: Pool;
  geminiModel: string;
}

/** Every lesson whose LATEST analysis is a usable synthesis source right now (completed or no_strategy) — computed fresh on every call, never cached, so "out of date" always reflects the current DB state. */
export async function computeCurrentSourceState(deps: SynthesisCoreDeps, courseId: number) {
  const lessons = await listLessons(deps.pool, courseId);
  const latestByLesson = await getLatestByLessons(deps.pool, lessons.map((l) => l.id));

  const analysisIds: number[] = [];
  const noStandaloneSetupLessons: { lessonId: number; title: string }[] = [];
  for (const lesson of lessons) {
    const analysis = latestByLesson.get(lesson.id);
    if (!analysis) continue;
    if (analysis.status === "completed") analysisIds.push(analysis.analysisId);
    else if (analysis.status === "no_strategy") {
      analysisIds.push(analysis.analysisId);
      noStandaloneSetupLessons.push({ lessonId: lesson.id, title: lesson.title });
    }
  }

  const hash = computeSourceAnalysisHash({
    courseId,
    analysisIds,
    model: deps.geminiModel,
    synthesisPromptVersion: SYNTHESIS_PROMPT_VERSION,
    synthesisSchemaVersion: SYNTHESIS_SCHEMA_VERSION,
    synthesizerVersion: SYNTHESIZER_VERSION,
  });

  // Phase 3.5B — reports whether the FULL course is current v2/current
  // fingerprint before a human decides to run production synthesis (see
  // synthesis/preflight.ts). Consumed two ways: GET .../synthesis-status
  // surfaces it read-only for the UI, and POST .../synthesize (below) hard
  // refuses to create a synthesis_run when it isn't ready — the same
  // readiness check the read-only diagnostic (scripts/synthesisDryRun.ts)
  // already enforced, now also enforced on the production write path.
  const preflight = computeSynthesisPreflight(lessons, latestByLesson, deps.geminiModel);

  return { lessons, analysisIds, noStandaloneSetupLessons, hash, preflight };
}

/**
 * Extends the existing run summary with computed (never separately
 * persisted) progress/heartbeat fields — see synthesis/progress.ts. Never
 * exposes prompt content, raw course material, API keys, tokens, or DB
 * credentials: only the safe counters/labels already on synthesis_runs
 * (current_stage, completed_items/total_items, current_item — a short
 * display label only) plus deterministic values computed from them.
 */
export function serializeRun(run: SynthesisRun | null) {
  if (!run) return null;
  const progress = computeSynthesisProgress({
    status: run.status,
    currentStage: run.currentStage,
    completedItems: run.completedItems,
    totalItems: run.totalItems,
  });
  const heartbeatTier = computeHeartbeatTier({
    status: run.status,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
  });

  return {
    runId: run.runId,
    status: run.status,
    currentStage: run.currentStage,
    sourceAnalysisHash: run.sourceAnalysisHash,
    model: run.model,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    thinkingTokens: run.thinkingTokens,
    estimatedCost: run.estimatedCost,
    processingDurationSeconds: run.processingDurationSeconds,
    errorType: run.errorType,
    sanitizedError: run.sanitizedError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    // Progress/observability (Phase 3.4 follow-up) — all derived from the
    // safe fields above plus the two-line-summary current_item; never the
    // Gemini prompt or raw course content that produced them.
    stageIndex: progress.stageIndex,
    totalStages: progress.totalStages,
    stageLabel: progress.stageLabel,
    overallProgress: progress.overallProgress,
    stageProgress: progress.stageProgress,
    isCountable: progress.isCountable,
    isIndeterminate: progress.isIndeterminate,
    completedItems: run.completedItems,
    totalItems: run.totalItems,
    currentItem: run.currentItem,
    lastHeartbeatAt: run.lastHeartbeatAt,
    leaseExpiresAt: run.leaseExpiresAt,
    heartbeatTier,
  };
}

/**
 * Phase 4E — the exact body of the former GET /api/course/synthesis-status
 * handler, extracted unchanged (same queries, same order, same computed
 * fields) so it can be called with a course resolved either way: via the
 * globally configured whopCourseId (legacy handler below) or via a
 * project's ownership (http/routes/projectSynthesis.ts). No synthesis
 * semantics were touched — this is a pure extract-function refactor.
 */
export async function buildSynthesisStatusPayload(deps: SynthesisCoreDeps, course: { id: number; title: string }) {
  const lessons = await listLessons(deps.pool, course.id);
  const lessonIds = lessons.map((l) => l.id);
  const [counts, currentSource, latestRun, latestCompletedRun] = await Promise.all([
    getSummaryCounts(deps.pool, lessonIds),
    computeCurrentSourceState(deps, course.id),
    getLatestRun(deps.pool, course.id),
    getLatestCompletedRun(deps.pool, course.id),
  ]);

  const analyzed = counts.completed + counts.noStrategy;
  const isOutOfDate = latestCompletedRun != null && latestCompletedRun.sourceAnalysisHash !== currentSource.hash;

  return {
    course: { title: course.title },
    counts: {
      totalLessons: lessons.length,
      analyzed,
      processing: counts.processing,
      queued: counts.queued,
      failed: counts.failed,
    },
    noStandaloneSetupLessons: currentSource.noStandaloneSetupLessons,
    latestRun: serializeRun(latestRun),
    latestCompletedRun: serializeRun(latestCompletedRun),
    isOutOfDate,
    canSynthesizeNow: analyzed > 0,
    preflight: currentSource.preflight,
  };
}

/**
 * GET /api/course/synthesis-status — everything the "Synthesize Course"
 * button and the Course Intelligence Overview tab need: how much of the
 * course is analyzed, the latest run (any status) and latest COMPLETED run,
 * and whether that completed run is out of date relative to the CURRENT
 * set of analyzed lessons. Read-only, never triggers anything.
 */
export function createSynthesisStatusHandler(deps: CourseSynthesisRouteDeps) {
  return async function synthesisStatusHandler(_req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(200).json({ course: null });
      return;
    }

    const payload = await buildSynthesisStatusPayload(deps, course);
    res.status(200).json(payload);
  };
}

interface SynthesizeBody {
  force?: boolean;
}

interface SynthesizeCoreDeps extends SynthesisCoreDeps {
  jobTrigger: JobTrigger;
}

/**
 * Phase 4E — the exact body of the former POST /api/course/synthesize
 * handler that runs once a course is already resolved, extracted unchanged
 * so it can be invoked with a course resolved either via the globally
 * configured whopCourseId (legacy handler below) or via a project's
 * ownership (http/routes/projectSynthesis.ts). Every readiness check
 * (nothing-to-synthesize, preflight, unchanged-hash short-circuit) and the
 * run-creation/job-trigger call are identical to before — pure
 * extract-function refactor, no synthesis semantics touched.
 */
export async function handleSynthesizeForCourse(deps: SynthesizeCoreDeps, res: Response, course: { id: number }, force: boolean): Promise<void> {
  const currentSource = await computeCurrentSourceState(deps, course.id);
  if (currentSource.analysisIds.length === 0) {
    res.status(409).json({
      error: { message: "No lessons have finished analysis yet — nothing to synthesize.", type: "nothing_to_synthesize" },
    });
    return;
  }

  // Final pre-merge safety fix — this is the SAME readiness check the read-only diagnostic
  // (scripts/synthesisDryRun.ts) already enforces (see synthesis/preflight.ts), now also
  // enforced here so production synthesis can never run against a course with a missing or
  // stale (pre-current-extractor-version) lesson analysis. Must run BEFORE any synthesis_run
  // row is created or worker synthesis is triggered — including when `force` is passed:
  // `force` only bypasses the unchanged-hash short-circuit below, never data readiness.
  if (!currentSource.preflight.ready) {
    res.status(409).json({
      error: {
        message: "The course is not ready for synthesis — some lesson analyses are missing or stale. Re-analyze the listed lessons under the current extractor version before synthesizing.",
        type: "preflight_not_ready",
        staleAnalysisCount: currentSource.preflight.staleAnalysisCount,
        missingAnalysisCount: currentSource.preflight.missingAnalysisCount,
        staleLessonIds: currentSource.preflight.staleLessonIds,
        staleLessonTitles: currentSource.preflight.staleLessonTitles,
        missingLessonIds: currentSource.preflight.missingLessonIds,
        missingLessonTitles: currentSource.preflight.missingLessonTitles,
      },
    });
    return;
  }

  if (!force) {
    const latestCompleted = await getLatestCompletedRun(deps.pool, course.id);
    if (latestCompleted && latestCompleted.sourceAnalysisHash === currentSource.hash) {
      res.status(200).json({ created: false, run: serializeRun(latestCompleted) });
      return;
    }
  }

  const run = await createSynthesisRun(deps.pool, {
    courseId: course.id,
    sourceAnalysisHash: currentSource.hash,
    sourceAnalysisIds: currentSource.analysisIds,
    model: deps.geminiModel,
    synthesisPromptVersion: SYNTHESIS_PROMPT_VERSION,
    synthesisSchemaVersion: SYNTHESIS_SCHEMA_VERSION,
    synthesizerVersion: SYNTHESIZER_VERSION,
  });

  try {
    await deps.jobTrigger.triggerRun();
  } catch (err) {
    // Durably queued in Postgres already — a failed trigger call is
    // recovered the next time any job trigger fires, not fatal here.
    logger.error("Failed to trigger worker Job execution after enqueueing a synthesis run", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  res.status(202).json({ created: true, run: serializeRun(run) });
}

/**
 * POST /api/course/synthesize — creates a new synthesis_runs row (or
 * returns the existing latest-completed run unchanged, if nothing about the
 * source analyses/model/versions has changed and `force` wasn't passed —
 * see synthesis/fingerprint.ts) and triggers the same Cloud Run Job used
 * for lesson analysis. Never blocks on the run actually finishing — this
 * always returns immediately, mirroring analysisJobs.ts's enqueue handler.
 * Never fires automatically: the only caller is this explicit user action.
 *
 * Final pre-merge safety fix — before any of that, refuses with 409
 * "preflight_not_ready" (stale/missing counts+details included) when
 * synthesis/preflight.ts's computeSynthesisPreflight reports the course
 * isn't ready (a lesson has no usable analysis, or its latest analysis
 * predates the current extractor version). No synthesis_run row is created
 * and the worker Job is never triggered in that case — even with `force`,
 * which only ever bypasses the unchanged-hash short-circuit below, never
 * data readiness.
 */
export function createSynthesizeHandler(deps: CourseSynthesisRouteDeps) {
  return async function synthesizeHandler(req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(404).json({ error: { message: "Course has not been synced yet.", type: "not_found" } });
      return;
    }

    const body = req.body as SynthesizeBody;
    const force = body?.force === true;
    await handleSynthesizeForCourse(deps, res, course, force);
  };
}

/**
 * Phase 4E — the exact body of the former GET /api/course/synthesis
 * handler (once a course is resolved), extracted unchanged so it can be
 * called with a course resolved either via the globally configured
 * whopCourseId (legacy handler below) or via a project's ownership
 * (http/routes/projectSynthesis.ts). Returns `{ run: null }` if no run has
 * ever completed for this course — same as before.
 */
export async function buildFullSynthesisPayload(deps: { pool: Pool }, course: { id: number }) {
  const run = await getLatestCompletedRun(deps.pool, course.id);
  if (!run) {
    return { run: null };
  }

  const [clusters, canonicalStrategies, playbookRow] = await Promise.all([
    listStrategyClustersByRun(deps.pool, run.runId),
    listCanonicalStrategiesByRun(deps.pool, run.runId),
    getCoursePlaybookByRun(deps.pool, run.runId),
  ]);

  return {
    run: serializeRun(run),
    clusters: clusters.map((c) => ({ clusterId: c.clusterId, clusterKey: c.clusterKey, canonicalName: c.canonicalName, cluster: c.cluster })),
    canonicalStrategies: canonicalStrategies.map((c) => ({ canonicalStrategyId: c.canonicalStrategyId, clusterId: c.clusterId, name: c.name, strategy: c.strategy })),
    coreFramework: playbookRow?.coreFramework ?? null,
    playbook: playbookRow?.playbook ?? null,
    decisionFramework: playbookRow?.decisionFramework ?? null,
  };
}

/**
 * GET /api/course/synthesis — the full latest COMPLETED run's data for the
 * Course Intelligence tabs (Canonical Strategies, Core Framework, Playbook,
 * Decision Framework, Conflicts, Sources). Returns `{ run: null }` if no
 * run has ever completed for this course.
 */
export function createGetSynthesisHandler(deps: CourseSynthesisRouteDeps) {
  return async function getSynthesisHandler(_req: Request, res: Response): Promise<void> {
    const course = await getCourseByWhopId(deps.pool, deps.whopCourseId);
    if (!course) {
      res.status(200).json({ run: null });
      return;
    }

    const payload = await buildFullSynthesisPayload(deps, course);
    res.status(200).json(payload);
  };
}
