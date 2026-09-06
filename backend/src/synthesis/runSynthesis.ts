import type { GeminiUsage } from "../gemini/client.js";
import { buildStrategySignature, type StrategyInstanceRecord } from "./normalize.js";
import { clusterStrategyInstances, type ClusterBatchProgress } from "./cluster.js";
import { synthesizeCanonicalStrategy } from "./canonicalStrategy.js";
import { extractCoreFramework } from "./coreFramework.js";
import { synthesizePlaybook } from "./playbook.js";
import { synthesizeDecisionFramework } from "./decisionFramework.js";
import { sumUsages } from "./usage.js";
import type { SynthesisStageDeps } from "./geminiStage.js";
import { CANONICAL_STRATEGY_THINKING_LEVEL } from "./limits.js";
import type { CanonicalStrategy, ClusterProposal, CoreFramework, CoursePlaybookDocument, DecisionFramework, FrameworkCoverage } from "./schema.js";

/**
 * The six Gemini-facing pipeline stages (see synthesis/progress.ts's
 * PROGRESS_STAGE_ORDER for the full 7-stage user-facing list, which adds
 * VALIDATING — the worker's post-runSynthesis persistence step, outside
 * this function entirely). Uppercase to read directly as the user-facing
 * stage name; CANONICALIZING replaces the old "synthesizing_canonical_strategies"
 * purely as a label — no pipeline behavior tied to this identifier changed.
 */
export type SynthesisStage = "NORMALIZING" | "CLUSTERING" | "CANONICALIZING" | "CORE_FRAMEWORK" | "PLAYBOOK" | "DECISION_FRAMEWORK";

/**
 * A progress event: always names the current stage, and carries countable
 * completed/total counts + a short current-item label ONLY when that stage
 * has real countable work available — null/null/null otherwise (core
 * framework, playbook, and decision framework are each a single Gemini
 * call with nothing to count sub-progress against; see progress.ts, which
 * treats a null total as "indeterminate" and never fabricates a
 * percentage for it).
 *
 * `cumulativeUsage` is the sum of every Gemini call that has actually
 * completed so far in THIS run (across all stages, not just the current
 * one) — reads directly off the same `usages` array this function already
 * accumulates for the final result, so it can never drift from the
 * authoritative total. Exists so a run that fails partway through still
 * has an accurate "cost so far" persisted (see worker/synthesisLoop.ts),
 * instead of losing all completed-call usage the moment the function
 * throws before returning its final SynthesisResult.
 */
export interface SynthesisProgressEvent {
  stage: SynthesisStage;
  completedItems: number | null;
  totalItems: number | null;
  currentItem: string | null;
  cumulativeUsage: GeminiUsage;
}

export interface SourceIndexEntry {
  lessonId: number;
  lessonTitle: string;
  chapterTitle: string | null;
  sourceUrl: string;
  contributedStrategyNames: string[];
}

export interface RunSynthesisInput {
  courseTitle: string;
  /** Every strategy instance from every contributing lesson's latest completed analysis. */
  instances: StrategyInstanceRecord[];
  /** Every contributing lesson (completed with a strategy, or no_strategy) — drives the Source Index, including lessons that contributed no strategy. */
  lessons: { id: number; title: string; chapterTitle: string | null; sourceUrl: string }[];
  /**
   * Ids (a subset of `lessons`) whose latest analysis was strategy_found=false
   * ("No Standalone Setup"). Used ONLY to generate the coverage-gap note
   * below — never sent to Gemini, which has no way to know what wasn't
   * given to it. See the note on buildCoverageNotesSection for why this
   * matters: the current extractor persists nothing beyond
   * strategy_found=false for these lessons (gemini/schema.ts forces
   * strategies=[] whenever strategy_found is false), so a lesson like
   * "Sizing & Scaling Trades" can legitimately teach critical risk
   * management / position sizing / psychology / trade-management content
   * that is simply absent from lesson_analyses today — this framework and
   * playbook must not be read as covering it.
   */
  noStandaloneSetupLessonIds: number[];
}

export interface ClusterWithStrategy {
  cluster: ClusterProposal;
  canonicalStrategy: CanonicalStrategy;
}

export interface SynthesisResult {
  clusters: ClusterWithStrategy[];
  coreFramework: CoreFramework;
  playbook: CoursePlaybookDocument;
  decisionFramework: DecisionFramework;
  usage: GeminiUsage;
}

/**
 * Orchestrates Stages 1-6 in sequence. `onProgress` is called at the start
 * of each stage and, for stages with countable work (normalizing,
 * clustering's batches, canonicalizing's per-cluster loop), again after
 * each item completes — the worker uses every call to persist progress and
 * renew the lease (see worker/synthesisLoop.ts), so a heartbeat-only
 * renewal (worker/heartbeat.ts) is never the only signal of progress for a
 * stage that itself takes minutes. Never fabricates progress mid-call:
 * core framework/playbook/decision framework each fire exactly one
 * "stage started" event with null counts, since each is a single Gemini
 * call with nothing to count sub-progress against.
 *
 * Every `onProgress` call is AWAITED before the next unit of work begins —
 * this is deliberate, not an oversight: it's what guarantees that "cluster
 * i complete" is durably persisted before cluster i+1 is even attempted,
 * so a failure on cluster i+1 can never race an unpersisted completion of
 * cluster i. `onProgress` may return void or a Promise; the worker's
 * implementation resolves once its DB write lands.
 */
export async function runSynthesis(
  deps: SynthesisStageDeps,
  input: RunSynthesisInput,
  onProgress?: (event: SynthesisProgressEvent) => void | Promise<void>,
): Promise<SynthesisResult> {
  const usages: GeminiUsage[] = [];
  const emit = async (stage: SynthesisStage, completedItems: number | null, totalItems: number | null, currentItem: string | null) => {
    await onProgress?.({ stage, completedItems, totalItems, currentItem, cumulativeUsage: sumUsages(usages) });
  };

  await emit("NORMALIZING", 0, input.instances.length, null);
  const signatures = input.instances.map(buildStrategySignature);
  await emit("NORMALIZING", input.instances.length, input.instances.length, null);

  await emit("CLUSTERING", 0, null, null); // total batch count isn't known until chunking happens inside clusterStrategyInstances
  const onBatchProgress = (p: ClusterBatchProgress) => emit("CLUSTERING", p.completedBatches, p.totalBatches, null);
  const { clusters, usages: clusterUsages } = await clusterStrategyInstances(deps, signatures, undefined, onBatchProgress);
  usages.push(...clusterUsages);

  await emit("CANONICALIZING", 0, clusters.length, clusters[0]?.proposedCanonicalName ?? null);
  const instancesById = new Map(input.instances.map((i) => [i.strategyInstanceId, i]));
  const clustersWithStrategy: ClusterWithStrategy[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    await emit("CANONICALIZING", i, clusters.length, cluster.proposedCanonicalName);
    const members = cluster.memberInstanceIds
      .map((id) => instancesById.get(id))
      .filter((m): m is StrategyInstanceRecord => m != null);
    // Explicit thinking_level="low" (synthesis/limits.ts's CANONICAL_STRATEGY_THINKING_LEVEL) —
    // confirmed by two real A/B/C diagnostic comparisons (see PR #11) to
    // produce identical correctness to the server default at 33-40% lower
    // cost. Scoped to this one call site only — every other stage in this
    // file omits thinkingLevel entirely, preserving the server default.
    const { canonicalStrategy, usage } = await synthesizeCanonicalStrategy(deps, cluster, members, {
      thinkingLevel: CANONICAL_STRATEGY_THINKING_LEVEL,
    });
    usages.push(usage);
    clustersWithStrategy.push({ cluster, canonicalStrategy });
    // Awaited: this cluster's completion (and its contribution to
    // cumulativeUsage) is durably persisted before the loop even
    // considers starting cluster i+1 — see the doc comment above.
    await emit("CANONICALIZING", i + 1, clusters.length, cluster.proposedCanonicalName);
  }
  const canonicalStrategies = clustersWithStrategy.map((c) => c.canonicalStrategy);

  await emit("CORE_FRAMEWORK", null, null, null);
  const { coreFramework, usage: coreFrameworkUsage } = await extractCoreFramework(deps, canonicalStrategies, input.instances);
  usages.push(coreFrameworkUsage);

  await emit("PLAYBOOK", null, null, null);
  const { playbook: playbookWithoutSourceIndex, usage: playbookUsage } = await synthesizePlaybook(
    deps,
    input.courseTitle,
    canonicalStrategies,
    coreFramework,
  );
  usages.push(playbookUsage);
  const playbook: CoursePlaybookDocument = {
    ...playbookWithoutSourceIndex,
    sections: [
      ...playbookWithoutSourceIndex.sections,
      buildCoverageNotesSection(input),
      buildSourceIndexSection(input, canonicalStrategies),
    ],
    frameworkCoverage: buildFrameworkCoverage(input),
  };

  await emit("DECISION_FRAMEWORK", null, null, null);
  const { decisionFramework, usage: decisionFrameworkUsage } = await synthesizeDecisionFramework(
    deps,
    canonicalStrategies,
    coreFramework,
  );
  usages.push(decisionFrameworkUsage);

  return {
    clusters: clustersWithStrategy,
    coreFramework,
    playbook,
    decisionFramework,
    usage: sumUsages(usages),
  };
}

/**
 * Structured coverage metadata — deterministic, never produced or inferred
 * by Gemini, and never a substitute for the prose Coverage Notes section
 * (this is the machine-readable form the frontend uses to render a
 * status pill and banner without parsing text). `status` is PARTIAL
 * whenever any "No Standalone Setup" lesson has not been processed by a
 * supplemental knowledge extractor — today that is ALL of them, since no
 * such extractor exists yet in this codebase; `missingSupportingKnowledge*`
 * therefore currently always equals the full "No Standalone Setup" set.
 * Once a TRADING_KNOWLEDGE_EXTRACTOR (or similar) exists and has actually
 * processed some of these lessons, this function is the one place that
 * would need to subtract that processed set to let status become COMPLETE
 * — nothing here infers or fabricates that a lesson's content is covered
 * just because it sounds like it should be.
 */
function buildFrameworkCoverage(input: RunSynthesisInput): FrameworkCoverage {
  const byId = new Map(input.lessons.map((l) => [l.id, l]));
  const missingLessons = input.noStandaloneSetupLessonIds.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => l != null);
  const standaloneStrategyLessonsAnalyzed = new Set(input.instances.map((i) => i.lessonId)).size;

  return {
    status: missingLessons.length > 0 ? "PARTIAL" : "COMPLETE",
    standaloneStrategyLessonsAnalyzed,
    lessonsWithoutStandaloneSetup: input.noStandaloneSetupLessonIds.length,
    lessonsMissingSupportingKnowledgeExtraction: missingLessons.length,
    missingSupportingKnowledgeLessonIds: missingLessons.map((l) => l.id),
    missingSupportingKnowledgeLessonTitles: missingLessons.map((l) => l.title),
    coverageNote:
      missingLessons.length > 0
        ? `Strategy synthesis complete. Course-framework coverage is partial: ${missingLessons.length} lesson(s) contain no standalone setup and have not yet been analyzed for supporting trading knowledge (risk management, sizing, psychology, trade management, etc.).`
        : "Strategy synthesis complete. Course-framework coverage is current — every analyzed lesson taught a standalone setup captured above.",
  };
}

/**
 * A deterministic, code-generated coverage-gap disclosure — never asked of
 * Gemini, which has no way to know what wasn't given to it. Lessons
 * classified "No Standalone Setup" (strategy_found=false) contribute
 * nothing to Stage 3 (no strategy_instances rows exist for them) and
 * nothing to Stage 4's pooled rule categories either, because the current
 * extractor discards everything but the lesson title/duration once
 * strategy_found is false (see gemini/schema.ts's refinement forcing
 * strategies=[]). A lesson like "Sizing & Scaling Trades" may teach
 * critical risk-management, position-sizing, psychology, or trade-
 * management content that this framework/playbook simply never saw.
 *
 * This is a real, confirmed coverage gap, not a hypothetical one — closing
 * it requires a future supplemental extractor (tentatively named
 * TRADING_KNOWLEDGE_EXTRACTOR) that could be run selectively on exactly
 * these lessons, producing its own artifact (risk management, position
 * sizing, scaling in/out, trade management, market preparation,
 * psychology, execution rules, warnings, principles, examples) stored
 * separately from — never forced into — the strategies schema, which Stage
 * 4 could then also pool from. Not implemented in this PR: no video is
 * reprocessed here, and this section only ever names the gap.
 */
function buildCoverageNotesSection(input: RunSynthesisInput) {
  if (input.noStandaloneSetupLessonIds.length === 0) {
    return {
      key: "coverage_notes",
      title: "Coverage Notes",
      content: "Every analyzed lesson in this course taught at least one standalone strategy or setup — no coverage gaps to report.",
    };
  }

  const byId = new Map(input.lessons.map((l) => [l.id, l]));
  const gapLessons = input.noStandaloneSetupLessonIds.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => l != null);

  const listing = gapLessons.map((l) => `- ${l.title}${l.chapterTitle ? ` (${l.chapterTitle})` : ""}`).join("\n");

  return {
    key: "coverage_notes",
    title: "Coverage Notes — What This Playbook Does NOT Cover",
    content: `The following ${gapLessons.length} lesson(s) were classified "No Standalone Setup" and are NOT represented anywhere else in this playbook or the Core Framework. This does not mean they taught nothing useful — it means the current analysis pipeline only extracts structured detail from lessons that teach a standalone, clusterable trading setup. A lesson on position sizing, scaling, trade psychology, or general risk management can be entirely absent from this document even though it may be essential to trading the strategies above correctly.\n\n${listing}\n\nClosing this gap requires re-analyzing these specific lessons with a supplemental extractor built for general course knowledge (risk management, position sizing, scaling, trade management, market preparation, psychology, execution, warnings, principles, examples) rather than standalone setups — out of scope for this synthesis run.`,
  };
}

/** Section 19 — deterministic, not synthesized: a plain listing of every contributing lesson and what it contributed. */
function buildSourceIndexSection(input: RunSynthesisInput, canonicalStrategies: CanonicalStrategy[]) {
  const strategyNamesByLesson = new Map<number, string[]>();
  for (const strategy of canonicalStrategies) {
    for (const lessonId of strategy.sourceLessonIds) {
      const existing = strategyNamesByLesson.get(lessonId) ?? [];
      existing.push(strategy.name);
      strategyNamesByLesson.set(lessonId, existing);
    }
  }

  const entries: SourceIndexEntry[] = input.lessons.map((lesson) => ({
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    chapterTitle: lesson.chapterTitle,
    sourceUrl: lesson.sourceUrl,
    contributedStrategyNames: strategyNamesByLesson.get(lesson.id) ?? [],
  }));

  const content = entries
    .map((e) => `- ${e.lessonTitle}${e.chapterTitle ? ` (${e.chapterTitle})` : ""}: ${e.contributedStrategyNames.length > 0 ? e.contributedStrategyNames.join(", ") : "no strategy taught"}`)
    .join("\n");

  return { key: "source_index", title: "Source Index", content };
}
