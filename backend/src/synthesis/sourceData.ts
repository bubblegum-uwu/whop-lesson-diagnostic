import type { Pool } from "pg";
import { getByAnalysisIds } from "../db/lessonAnalysesRepo.js";
import { listInstancesByAnalysisIds } from "../db/strategyInstancesRepo.js";
import { getLessonsByIds } from "../db/lessonsRepo.js";
import type { RunSynthesisInput } from "./runSynthesis.js";
import type { StrategyInstanceRecord } from "./normalize.js";

/**
 * Builds runSynthesis's input from an already-frozen set of analysis ids
 * (see synthesisRunsRepo.createSynthesisRun / the route that computes and
 * freezes this set) — the worker never re-resolves "latest analysis per
 * lesson" itself, so a lesson re-analyzed while this run sat QUEUED can
 * never change what it actually synthesizes from. Source data only: never
 * writes to lesson_analyses/strategy_instances.
 */
export async function gatherSynthesisInput(pool: Pool, courseTitle: string, analysisIds: number[]): Promise<RunSynthesisInput> {
  const analyses = await getByAnalysisIds(pool, analysisIds);
  const lessonIds = analyses.map((a) => a.lessonId);
  const lessons = await getLessonsByIds(pool, lessonIds);
  const lessonById = new Map(lessons.map((l) => [l.id, l]));

  const completedAnalysisIds = analyses.filter((a) => a.status === "completed").map((a) => a.analysisId);
  const noStandaloneSetupLessonIds = analyses.filter((a) => a.status === "no_strategy").map((a) => a.lessonId);

  const instanceRows = await listInstancesByAnalysisIds(pool, completedAnalysisIds);
  const instances: StrategyInstanceRecord[] = instanceRows.map((row) => ({
    strategyInstanceId: row.strategyInstanceId,
    lessonId: row.lessonId,
    lessonTitle: lessonById.get(row.lessonId)?.title ?? `Lesson ${row.lessonId}`,
    analysisId: row.analysisId,
    strategyName: row.strategyName,
    normalizedName: row.normalizedName,
    strategy: row.strategy,
  }));

  return {
    courseTitle,
    instances,
    lessons: lessons.map((l) => ({ id: l.id, title: l.title, chapterTitle: l.chapterTitle, sourceUrl: l.sourceUrl })),
    noStandaloneSetupLessonIds,
  };
}
