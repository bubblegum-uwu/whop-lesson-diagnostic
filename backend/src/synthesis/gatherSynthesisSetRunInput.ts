import type { Pool } from "pg";
import { listRunSourceInputs, listRunLessonInputs } from "../db/synthesisSetRunsRepo.js";
import { getByAnalysisIds as getProjectSourceAnalysesByIds } from "../db/projectSourceAnalysesRepo.js";
import { getByAnalysisIds as getLessonAnalysesByIds } from "../db/lessonAnalysesRepo.js";
import type { RunSynthesisInput } from "./runSynthesis.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import type { LessonKnowledgeSource } from "./knowledgeNormalize.js";

/**
 * Phase 4M follow-up — the native-Run counterpart to sourceData.ts's
 * gatherSynthesisInput. Reuses runSynthesis() completely unchanged (see its
 * own doc comment: it is already 100% frozen-in-memory-list based, with no
 * SQL of its own) by building the SAME RunSynthesisInput shape from a
 * native Run's own immutable snapshot tables (synthesis_set_run_sources /
 * synthesis_set_run_lessons) instead of lesson_analyses ids alone.
 *
 * THE EXECUTOR MUST NEVER RE-RESOLVE CURRENT SYNTHESIS SET MEMBERSHIP: this
 * function only ever reads `runId`'s own frozen snapshot rows (via
 * listRunSourceInputs/listRunLessonInputs — see synthesisSetRunsRepo.ts,
 * joined against project_sources/lessons+courses ONLY for their own
 * immutable title/url metadata, never against synthesis_set_sources/
 * synthesis_set_lessons, i.e. CURRENT membership) plus the EXACT analysis
 * rows those snapshot rows name (getByAnalysisIds, never
 * getLatestByProjectSource/getLatestByLessons). A source deselected, or
 * re-analyzed into a newer analysis row, after this Run was created can
 * never change what this function returns for it.
 *
 * Deliberately bypasses strategy_instances entirely (unlike
 * gatherSynthesisInput, which reads it) — that table is hard-FK'd to
 * lesson_analyses/lessons only (see the Phase 4H-B migration's own doc
 * comment: project sources were deliberately never given an equivalent
 * table), so a generic source+lesson executor instead derives
 * StrategyInstanceRecord[] directly from each analysis's own
 * validatedJson.strategies — project_source_analyses.validated_json and
 * lesson_analyses.validated_json are the EXACT SAME LessonStrategyAnalysis
 * shape (gemini/schema.ts, unchanged), so this works identically for both
 * kinds without ever converting one into the other's table.
 *
 * `id`/`lessonId`/`strategyInstanceId` fields on the records this builds
 * are SYNTHETIC, run-local slot ids — never a real project_source_id or
 * lessons.id. They exist only to correlate in-memory pipeline records
 * within this one execution (clustering, canonical-strategy
 * sourceLessonIds, the playbook's Source Index) and are never written back
 * to any table. The exact real-row provenance (which project_source /
 * lesson, which exact analysis_id) is already durably recorded in the
 * Run's own snapshot tables and served by GET .../runs/:runId/inputs —
 * that, not anything embedded in this function's output, is the
 * authoritative provenance API.
 */
function normalizeStrategyName(name: string): string {
  // Mirrors db/strategyInstancesRepo.ts's own (private) normalizeName
  // exactly — duplicated rather than imported so this file never depends on
  // a table (strategy_instances) it deliberately never writes to.
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function gatherSynthesisSetRunInput(pool: Pool, synthesisSetName: string, runId: string): Promise<RunSynthesisInput> {
  const [sourceInputs, lessonInputs] = await Promise.all([listRunSourceInputs(pool, runId), listRunLessonInputs(pool, runId)]);

  const [sourceAnalyses, lessonAnalyses] = await Promise.all([
    getProjectSourceAnalysesByIds(pool, sourceInputs.map((s) => s.analysisId)),
    getLessonAnalysesByIds(pool, lessonInputs.map((l) => l.analysisId)),
  ]);
  const sourceAnalysisById = new Map(sourceAnalyses.map((a) => [a.analysisId, a]));
  const lessonAnalysisById = new Map(lessonAnalyses.map((a) => [a.analysisId, a]));

  let nextSlotId = 1;
  let nextStrategyInstanceId = 1;
  const instances: StrategyInstanceRecord[] = [];
  const knowledgeSources: LessonKnowledgeSource[] = [];
  const lessons: RunSynthesisInput["lessons"] = [];
  const noStandaloneSetupLessonIds: number[] = [];

  for (const s of sourceInputs) {
    const analysis = sourceAnalysisById.get(s.analysisId);
    if (!analysis) continue; // Defensive only — a frozen snapshot row always has a corresponding analysis row (ON DELETE CASCADE keeps them consistent).
    const slotId = nextSlotId++;
    const title = s.title ?? s.sourceUrl;
    lessons.push({ id: slotId, title, chapterTitle: null, sourceUrl: s.sourceUrl });
    if (analysis.status === "completed") {
      for (const strategy of analysis.validatedJson.strategies) {
        instances.push({
          strategyInstanceId: nextStrategyInstanceId++,
          lessonId: slotId,
          lessonTitle: title,
          analysisId: s.analysisId,
          strategyName: strategy.strategy_name,
          normalizedName: normalizeStrategyName(strategy.strategy_name),
          strategy,
        });
      }
    } else {
      noStandaloneSetupLessonIds.push(slotId);
    }
    knowledgeSources.push({ analysisId: s.analysisId, lessonId: slotId, lessonTitle: title, knowledge: analysis.validatedJson.knowledge });
  }

  for (const l of lessonInputs) {
    const analysis = lessonAnalysisById.get(l.analysisId);
    if (!analysis) continue;
    const slotId = nextSlotId++;
    lessons.push({ id: slotId, title: l.title, chapterTitle: null, sourceUrl: l.sourceUrl });
    if (analysis.status === "completed") {
      for (const strategy of analysis.validatedJson.strategies) {
        instances.push({
          strategyInstanceId: nextStrategyInstanceId++,
          lessonId: slotId,
          lessonTitle: l.title,
          analysisId: l.analysisId,
          strategyName: strategy.strategy_name,
          normalizedName: normalizeStrategyName(strategy.strategy_name),
          strategy,
        });
      }
    } else {
      noStandaloneSetupLessonIds.push(slotId);
    }
    knowledgeSources.push({ analysisId: l.analysisId, lessonId: slotId, lessonTitle: l.title, knowledge: analysis.validatedJson.knowledge });
  }

  return {
    courseTitle: synthesisSetName,
    instances,
    lessons,
    noStandaloneSetupLessonIds,
    knowledgeSources,
  };
}
