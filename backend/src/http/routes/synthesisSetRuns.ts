import type { Request, Response } from "express";
import type { Pool } from "pg";
import { resolveOwnedSynthesisSet } from "./synthesisSets.js";
import { listProjectSourceIdsForSynthesisSet } from "../../db/synthesisSetSourcesRepo.js";
import { listLessonIdsForSynthesisSet } from "../../db/synthesisSetLessonsRepo.js";
import { getLatestByProjectSource } from "../../db/projectSourceAnalysesRepo.js";
import { getLatestByLessons, getByAnalysisIds } from "../../db/lessonAnalysesRepo.js";
import { getLessonsByIds } from "../../db/lessonsRepo.js";
import {
  createSynthesisSetRun,
  getSynthesisSetRunById,
  listSynthesisSetRuns,
  listRunSourceInputs,
  listRunLessonInputs,
  type SynthesisSetRunRow,
} from "../../db/synthesisSetRunsRepo.js";
import { listLegacyRunIdsForSynthesisSet } from "../../db/synthesisSetLegacyRunsRepo.js";
import { getSynthesisRunsByIds, getSynthesisRun, type SynthesisRun } from "../../db/synthesisRunsRepo.js";
import { getCoursePlaybookByRun } from "../../db/coursePlaybooksRepo.js";
import { SYNTHESIS_PROMPT_VERSION } from "../../synthesis/version.js";
import type { JobTrigger } from "../../jobs/runJobTrigger.js";
import { logger } from "../../lib/logger.js";

export interface SynthesisSetRunsRouteDeps {
  pool: Pool;
  /** Phase 4M follow-up — the SAME jobTrigger as every other Cloud Run Job phase (see http/app.ts) — triggering it after Run creation wakes the same container/execution that also runs worker/synthesisSetRunLoop.ts, never a second Cloud Run Job. */
  jobTrigger: JobTrigger;
  geminiModel: string;
}

const NOT_FOUND_SET_RESPONSE = { error: { message: "Unknown synthesis set.", type: "synthesis_set_not_found" } } as const;
const NOT_FOUND_RUN_RESPONSE = { error: { message: "Unknown run for this synthesis set.", type: "run_not_found" } } as const;
const NOTHING_READY_RESPONSE = {
  error: { message: "No currently-selected item has a usable analysis yet — nothing eligible to run synthesis on.", type: "nothing_ready" },
} as const;
const OUTPUT_NOT_AVAILABLE_RESPONSE = { error: { message: "This run has no output yet.", type: "run_output_not_available" } } as const;

/**
 * Phase 4M — a Run's headline shape as returned by the list/get endpoints,
 * unifying a NATIVE run (synthesis_set_runs, this phase) and a recovered
 * LEGACY_WHOP run (synthesis_set_legacy_runs -> synthesis_runs, pre-4M) into
 * one read model — never two competing shapes the frontend has to branch on
 * beyond checking `kind`. A legacy run's `readyCount`/`skippedNotReadyCount`
 * are always `sourceCount`/`0` — there was no "partial" concept in the old
 * course-wide engine (every analysis referenced by source_analysis_ids was
 * used, full stop), so this is a faithful, not fabricated, representation.
 */
interface UnifiedRunSummary {
  runId: string;
  kind: "NATIVE" | "LEGACY_WHOP";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  sourceCount: number;
  readyCount: number;
  skippedNotReadyCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  estimatedCost: number | null;
  processingDurationSeconds: number | null;
  errorType: string | null;
  sanitizedError: string | null;
  hasOutput: boolean;
}

function nativeRunToSummary(run: SynthesisSetRunRow): UnifiedRunSummary {
  return {
    runId: run.runId,
    kind: "NATIVE",
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    model: run.model,
    promptVersion: run.promptVersion,
    sourceCount: run.sourceCount,
    readyCount: run.readyCount,
    skippedNotReadyCount: run.skippedNotReadyCount,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    thinkingTokens: run.thinkingTokens,
    estimatedCost: run.estimatedCost,
    processingDurationSeconds: run.processingDurationSeconds,
    errorType: run.errorType,
    sanitizedError: run.sanitizedError,
    hasOutput: run.resultJson != null,
  };
}

function legacyRunToSummary(run: SynthesisRun, hasPlaybook: boolean): UnifiedRunSummary {
  return {
    runId: run.runId,
    kind: "LEGACY_WHOP",
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    model: run.model,
    promptVersion: run.synthesisPromptVersion,
    sourceCount: run.sourceAnalysisIds.length,
    readyCount: run.sourceAnalysisIds.length,
    skippedNotReadyCount: 0,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    thinkingTokens: run.thinkingTokens,
    estimatedCost: run.estimatedCost,
    processingDurationSeconds: run.processingDurationSeconds,
    errorType: run.errorType,
    sanitizedError: run.sanitizedError,
    hasOutput: hasPlaybook,
  };
}

async function loadUnifiedRuns(pool: Pool, synthesisSetId: number): Promise<UnifiedRunSummary[]> {
  const [nativeRuns, legacyRunIds] = await Promise.all([listSynthesisSetRuns(pool, synthesisSetId), listLegacyRunIdsForSynthesisSet(pool, synthesisSetId)]);
  const legacyRuns = await getSynthesisRunsByIds(pool, legacyRunIds);
  const legacySummaries = await Promise.all(
    legacyRuns.map(async (run) => {
      const playbook = run.status === "COMPLETED" ? await getCoursePlaybookByRun(pool, run.runId) : null;
      return legacyRunToSummary(run, playbook !== null);
    }),
  );
  const all = [...nativeRuns.map(nativeRunToSummary), ...legacySummaries];
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return all;
}

/** GET /api/projects/:projectId/synthesis-sets/:setId/runs — every Run (native and recovered legacy alike) for this set, newest first. Pure read. */
export function createListSynthesisSetRunsHandler(deps: SynthesisSetRunsRouteDeps) {
  return async function listSynthesisSetRunsHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_SET_RESPONSE);
      return;
    }
    const runs = await loadUnifiedRuns(deps.pool, resolved.set.id);
    res.status(200).json({ synthesisSetId: resolved.set.id, runs });
  };
}

/** GET .../runs/:runId — one Run's summary, native or legacy. Same deterministic 404 for an unknown run OR a run that belongs to a different set/project. */
export function createGetSynthesisSetRunHandler(deps: SynthesisSetRunsRouteDeps) {
  return async function getSynthesisSetRunHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_SET_RESPONSE);
      return;
    }
    const runId = typeof req.params.runId === "string" ? req.params.runId : "";

    const nativeRun = await getSynthesisSetRunById(deps.pool, runId);
    if (nativeRun && nativeRun.synthesisSetId === resolved.set.id) {
      res.status(200).json(nativeRunToSummary(nativeRun));
      return;
    }

    const legacyRunIds = await listLegacyRunIdsForSynthesisSet(deps.pool, resolved.set.id);
    if (legacyRunIds.includes(runId)) {
      const run = await getSynthesisRun(deps.pool, runId);
      if (run) {
        const playbook = run.status === "COMPLETED" ? await getCoursePlaybookByRun(deps.pool, run.runId) : null;
        res.status(200).json(legacyRunToSummary(run, playbook !== null));
        return;
      }
    }

    res.status(404).json(NOT_FOUND_RUN_RESPONSE);
  };
}

interface RunInputRow {
  kind: "SOURCE" | "WHOP_LESSON";
  id: number;
  title: string | null;
  provider: string;
  analysisId: number;
  courseId?: number;
  courseTitle?: string;
}

/** GET .../runs/:runId/inputs — the Run's frozen input provenance: exactly which sources/lessons, at exactly which analysis version, went into it. Never re-derived from CURRENT membership — for a native run this reads the immutable snapshot tables; for a legacy run it re-derives from that run's own immutable source_analysis_ids (the same derivation the recovery script itself used — never a different rule). */
export function createGetSynthesisSetRunInputsHandler(deps: SynthesisSetRunsRouteDeps) {
  return async function getSynthesisSetRunInputsHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_SET_RESPONSE);
      return;
    }
    const runId = typeof req.params.runId === "string" ? req.params.runId : "";

    const nativeRun = await getSynthesisSetRunById(deps.pool, runId);
    if (nativeRun && nativeRun.synthesisSetId === resolved.set.id) {
      const [sourceInputs, lessonInputs] = await Promise.all([listRunSourceInputs(deps.pool, runId), listRunLessonInputs(deps.pool, runId)]);
      const inputs: RunInputRow[] = [
        ...sourceInputs.map((s) => ({ kind: "SOURCE" as const, id: s.projectSourceId, title: s.title ?? s.sourceUrl, provider: s.provider, analysisId: s.analysisId })),
        ...lessonInputs.map((l) => ({ kind: "WHOP_LESSON" as const, id: l.lessonId, title: l.title, provider: "WHOP", analysisId: l.analysisId, courseId: l.courseId, courseTitle: l.courseTitle })),
      ];
      res.status(200).json({ runId, kind: "NATIVE", inputs });
      return;
    }

    const legacyRunIds = await listLegacyRunIdsForSynthesisSet(deps.pool, resolved.set.id);
    if (legacyRunIds.includes(runId)) {
      const run = await getSynthesisRun(deps.pool, runId);
      if (run) {
        const analyses = await getByAnalysisIds(deps.pool, run.sourceAnalysisIds);
        const lessons = await getLessonsByIds(deps.pool, [...new Set(analyses.map((a) => a.lessonId))]);
        const lessonById = new Map(lessons.map((l) => [l.id, l]));
        const inputs: RunInputRow[] = analyses.map((a) => {
          const lesson = lessonById.get(a.lessonId);
          return { kind: "WHOP_LESSON" as const, id: a.lessonId, title: lesson?.title ?? null, provider: "WHOP", analysisId: a.analysisId, courseId: lesson?.courseId };
        });
        res.status(200).json({ runId, kind: "LEGACY_WHOP", inputs });
        return;
      }
    }

    res.status(404).json(NOT_FOUND_RUN_RESPONSE);
  };
}

/** GET .../runs/:runId/output — the Run's result. Native: `result_json` once COMPLETED (404 before then — never fabricated). Legacy: the existing, immutable course_playbooks row (core framework / playbook / decision framework) — never regenerated, never copied. */
export function createGetSynthesisSetRunOutputHandler(deps: SynthesisSetRunsRouteDeps) {
  return async function getSynthesisSetRunOutputHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_SET_RESPONSE);
      return;
    }
    const runId = typeof req.params.runId === "string" ? req.params.runId : "";

    const nativeRun = await getSynthesisSetRunById(deps.pool, runId);
    if (nativeRun && nativeRun.synthesisSetId === resolved.set.id) {
      if (nativeRun.status !== "COMPLETED" || nativeRun.resultJson == null) {
        res.status(404).json(OUTPUT_NOT_AVAILABLE_RESPONSE);
        return;
      }
      res.status(200).json({ runId, kind: "NATIVE", result: nativeRun.resultJson });
      return;
    }

    const legacyRunIds = await listLegacyRunIdsForSynthesisSet(deps.pool, resolved.set.id);
    if (legacyRunIds.includes(runId)) {
      const playbook = await getCoursePlaybookByRun(deps.pool, runId);
      if (!playbook) {
        res.status(404).json(OUTPUT_NOT_AVAILABLE_RESPONSE);
        return;
      }
      res.status(200).json({
        runId,
        kind: "LEGACY_WHOP",
        result: { title: playbook.title, coreFramework: playbook.coreFramework, playbook: playbook.playbook, decisionFramework: playbook.decisionFramework },
      });
      return;
    }

    res.status(404).json(NOT_FOUND_RUN_RESPONSE);
  };
}

interface CreateRunBody {
  acknowledgePartial?: unknown;
}

/**
 * POST .../runs — "Run Synthesis": the ONE explicit action that creates an
 * immutable Run. Resolves CURRENT membership right now, keeps only the
 * items with a usable analysis (see isSourceEligibleForSynthesis /
 * isLessonEligibleForSynthesis — the exact same eligibility rule the
 * Synthesis Set's own selection UI already uses, never a stricter or looser
 * one here), and snapshots the EXACT analysis row each one currently
 * resolves to. That snapshot — not current membership — is what every
 * later read of this Run returns, forever (see synthesisSetRunsRepo.ts /
 * the migration's doc comment).
 *
 * If any currently-selected item is NOT yet ready, this refuses to
 * silently drop it: the first call (without `acknowledgePartial: true`)
 * returns 409 with the exact ready/skipped breakdown instead of creating
 * anything, so the frontend can show the user "26 ready · 2 need analysis"
 * and require an explicit decision before a second, acknowledged call
 * actually creates the Run (which then legitimately includes only the
 * ready subset — the skip is recorded, permanently, on the Run itself via
 * skippedNotReadyCount, never silently invisible).
 *
 * Deliberately does NOT: enqueue analysis for the not-ready items, touch
 * synthesis_set_sources/synthesis_set_lessons (current membership is
 * untouched by creating a Run), or execute any actual synthesis — this
 * phase ships Run creation/snapshot/history; a future phase wires real
 * execution onto the QUEUED status this leaves the Run in (see the
 * migration's doc comment on result_json).
 */
export function createCreateSynthesisSetRunHandler(deps: SynthesisSetRunsRouteDeps) {
  return async function createSynthesisSetRunHandler(req: Request, res: Response): Promise<void> {
    const resolved = await resolveOwnedSynthesisSet(deps.pool, req.params.projectId, req.params.setId);
    if (!resolved) {
      res.status(404).json(NOT_FOUND_SET_RESPONSE);
      return;
    }
    const { set } = resolved;
    const body = req.body as CreateRunBody;
    const acknowledgePartial = body?.acknowledgePartial === true;

    const [memberSourceIds, memberLessonIds] = await Promise.all([listProjectSourceIdsForSynthesisSet(deps.pool, set.id), listLessonIdsForSynthesisSet(deps.pool, set.id)]);

    const readySources: { projectSourceId: number; projectSourceAnalysisId: number }[] = [];
    let skippedSources = 0;
    for (const sourceId of memberSourceIds) {
      const latest = await getLatestByProjectSource(deps.pool, sourceId);
      const eligible = latest != null && (latest.status === "completed" || latest.status === "no_strategy");
      if (eligible && latest) readySources.push({ projectSourceId: sourceId, projectSourceAnalysisId: latest.analysisId });
      else skippedSources++;
    }

    const latestByLesson = await getLatestByLessons(deps.pool, memberLessonIds);
    const readyLessons: { lessonId: number; lessonAnalysisId: number }[] = [];
    let skippedLessons = 0;
    for (const lessonId of memberLessonIds) {
      const latest = latestByLesson.get(lessonId);
      const eligible = latest != null && (latest.status === "completed" || latest.status === "no_strategy");
      if (eligible && latest) readyLessons.push({ lessonId, lessonAnalysisId: latest.analysisId });
      else skippedLessons++;
    }

    const readyCount = readySources.length + readyLessons.length;
    const skippedNotReadyCount = skippedSources + skippedLessons;

    if (readyCount === 0) {
      res.status(400).json(NOTHING_READY_RESPONSE);
      return;
    }
    if (skippedNotReadyCount > 0 && !acknowledgePartial) {
      res.status(409).json({
        error: { message: "Some selected items are not yet analyzed.", type: "partial_selection_requires_confirmation" },
        readyCount,
        skippedNotReadyCount,
        totalSelected: readyCount + skippedNotReadyCount,
      });
      return;
    }

    const run = await createSynthesisSetRun(deps.pool, {
      synthesisSetId: set.id,
      projectId: set.projectId,
      model: deps.geminiModel,
      promptVersion: SYNTHESIS_PROMPT_VERSION,
      sources: readySources,
      lessons: readyLessons,
      skippedNotReadyCount,
    });

    // Fire-and-forget, exactly like handleSynthesizeForCourse — the Run is
    // already durably QUEUED in Postgres; a failed trigger call is
    // recovered the next time ANY job trigger fires (see
    // worker/synthesisSetRunLoop.ts, the fifth phase of the same Cloud Run
    // Job every other trigger call already wakes), never fatal here.
    try {
      await deps.jobTrigger.triggerRun();
    } catch (err) {
      logger.error("Failed to trigger synthesis-set-run worker execution", { runId: run.runId, message: err instanceof Error ? err.message : String(err) });
    }

    res.status(201).json(nativeRunToSummary(run));
  };
}
