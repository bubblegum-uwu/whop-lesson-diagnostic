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
import { normalizeLessonKnowledge, collectRawStrategyScopeNames, type LessonKnowledgeSource, type KnowledgeItemRecord, type NormalizedKnowledge } from "./knowledgeNormalize.js";
import { buildClusterCandidates, resolveStrategyScopeNames } from "./strategyScopeMapping.js";
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
  /**
   * Phase 3.5B — `knowledge` from EVERY contributing lesson's latest
   * analysis (completed AND no_strategy — see sourceData.ts). This is what
   * makes a "No Standalone Setup" lesson contribute real content instead of
   * only a coverage-gap disclosure: see normalizeLessonKnowledge, which
   * splits this into global/strategy-scoped/other-scoped buckets consumed
   * below by canonical-strategy enrichment, core-framework pooling, and
   * frameworkCoverage.
   */
  knowledgeSources: LessonKnowledgeSource[];
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
  // Phase 3.5B — deterministic, no Gemini call, same "normalization" stage
  // as the strategy-instance signatures above: flattens every contributing
  // lesson's rich knowledge (completed AND no_strategy) and splits it into
  // global / strategy-scoped / other-scoped buckets (knowledgeNormalize.ts).
  const normalizedKnowledge = normalizeLessonKnowledge(input.knowledgeSources);
  await emit("NORMALIZING", input.instances.length, input.instances.length, null);

  await emit("CLUSTERING", 0, null, null); // total batch count isn't known until chunking happens inside clusterStrategyInstances
  const onBatchProgress = (p: ClusterBatchProgress) => emit("CLUSTERING", p.completedBatches, p.totalBatches, null);
  const { clusters, usages: clusterUsages } = await clusterStrategyInstances(deps, signatures, undefined, onBatchProgress);
  usages.push(...clusterUsages);

  // Phase 3.5B — maps every raw strategy name referenced by a
  // strategy-scoped KnowledgeItem (e.g. "B&R") to the cluster it actually
  // belongs to, now that clusters exist. Deterministic first, a single
  // batched Gemini call only for what's left unresolved (strategyScopeMapping.ts)
  // — never per item, never per cluster. A name that still can't be placed
  // is preserved, never dropped (see unmatchedStrategyKnowledge below).
  const clusterCandidates = buildClusterCandidates(clusters, input.instances);
  const rawScopeNames = collectRawStrategyScopeNames(normalizedKnowledge.strategyScopedItems);
  const { result: scopeMapping, usage: scopeMappingUsage } = await resolveStrategyScopeNames(deps, rawScopeNames, clusterCandidates);
  if (scopeMappingUsage) usages.push(scopeMappingUsage);

  const knowledgeByCluster = new Map<string, KnowledgeItemRecord[]>();
  const unmatchedStrategyKnowledge: KnowledgeItemRecord[] = [];
  for (const record of normalizedKnowledge.strategyScopedItems) {
    const clusterKeys = new Set(record.item.scope.strategies.map((name) => scopeMapping.mapped.get(name)).filter((k): k is string => k != null));
    if (clusterKeys.size === 0) {
      unmatchedStrategyKnowledge.push(record);
      continue;
    }
    for (const clusterKey of clusterKeys) {
      const existing = knowledgeByCluster.get(clusterKey) ?? [];
      existing.push(record);
      knowledgeByCluster.set(clusterKey, existing);
    }
  }

  await emit("CANONICALIZING", 0, clusters.length, clusters[0]?.proposedCanonicalName ?? null);
  const instancesById = new Map(input.instances.map((i) => [i.strategyInstanceId, i]));
  const clustersWithStrategy: ClusterWithStrategy[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    await emit("CANONICALIZING", i, clusters.length, cluster.proposedCanonicalName);
    const members = cluster.memberInstanceIds
      .map((id) => instancesById.get(id))
      .filter((m): m is StrategyInstanceRecord => m != null);
    const scopedKnowledge = knowledgeByCluster.get(cluster.clusterKey) ?? [];
    // Explicit thinking_level="low" (synthesis/limits.ts's CANONICAL_STRATEGY_THINKING_LEVEL) —
    // confirmed by two real A/B/C diagnostic comparisons (see PR #11) to
    // produce identical correctness to the server default at 33-40% lower
    // cost. Scoped to this one call site only — every other stage in this
    // file omits thinkingLevel entirely, preserving the server default.
    const { canonicalStrategy, usage } = await synthesizeCanonicalStrategy(
      deps,
      cluster,
      members,
      { thinkingLevel: CANONICAL_STRATEGY_THINKING_LEVEL },
      scopedKnowledge,
    );
    usages.push(usage);
    clustersWithStrategy.push({ cluster, canonicalStrategy });
    // Awaited: this cluster's completion (and its contribution to
    // cumulativeUsage) is durably persisted before the loop even
    // considers starting cluster i+1 — see the doc comment above.
    await emit("CANONICALIZING", i + 1, clusters.length, cluster.proposedCanonicalName);
  }
  const canonicalStrategies = clustersWithStrategy.map((c) => c.canonicalStrategy);

  await emit("CORE_FRAMEWORK", null, null, null);
  // Phase 3.5B — GLOBAL knowledge plus knowledge scoped only by
  // instrument/timeframe/session/trader-profile (never strategy-scoped —
  // that goes to canonical strategy enrichment above; unmatched
  // strategy-scoped knowledge is deliberately excluded from here too, since
  // feeding an unattributed strategy-scoped rule into the course-wide
  // framework would misrepresent it as universal — see
  // buildUnmatchedStrategyKnowledgeSection below).
  const courseKnowledge = [...normalizedKnowledge.globalItems, ...normalizedKnowledge.otherScopedItems];
  const { coreFramework, usage: coreFrameworkUsage } = await extractCoreFramework(deps, canonicalStrategies, input.instances, courseKnowledge);
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
      ...(unmatchedStrategyKnowledge.length > 0 ? [buildUnmatchedStrategyKnowledgeSection(unmatchedStrategyKnowledge)] : []),
    ],
    frameworkCoverage: buildFrameworkCoverage(input, normalizedKnowledge),
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
 * Phase 3.5B — the 13 knowledgeItems categories (gemini/schema.ts's
 * KnowledgeCategory) treated as the deterministic coverage dimensions for
 * the course-wide framework. Deliberately independent of strategy_found,
 * strategy_instances, or canonical-strategy counts (the exact things the
 * pre-3.5B version of this function keyed off) — a dimension counts as
 * covered purely by whether real KnowledgeItem evidence exists for it
 * anywhere in the course, computed from input data BEFORE Gemini ever
 * runs, so it can never be "more confident" than the actual source
 * material.
 */
const COVERAGE_DIMENSIONS: { key: string; label: string }[] = [
  { key: "market_context", label: "Market Context / Structure" },
  { key: "higher_timeframe", label: "Higher-Timeframe Analysis" },
  { key: "risk_management", label: "Risk Management" },
  { key: "position_sizing", label: "Position Sizing" },
  { key: "scaling_in", label: "Scaling In" },
  { key: "scaling_out", label: "Scaling Out" },
  { key: "trade_management", label: "Trade Management" },
  { key: "execution", label: "Execution" },
  { key: "preparation", label: "Preparation / Routine" },
  { key: "psychology", label: "Psychology / Discipline" },
  { key: "no_trade_conditions", label: "No-Trade Conditions" },
  { key: "warnings", label: "Warnings / Common Mistakes" },
  { key: "definitions", label: "Definitions / Terminology" },
];

/**
 * Structured coverage metadata — deterministic, never produced or inferred
 * by Gemini, and never a substitute for the prose Coverage Notes section
 * (this is the machine-readable form the frontend uses to render a status
 * pill and banner without parsing text).
 *
 * Phase 3.5B redesign: `status` no longer depends on strategy_found counts,
 * instance counts, or canonical-strategy counts — a "No Standalone Setup"
 * lesson is NO LONGER itself treated as a coverage gap, because its rich
 * knowledge now DOES flow into the course-wide framework (see
 * courseKnowledge above). Coverage is instead computed from two genuinely
 * independent, evidence-based signals: (1) which of the 13 tracked
 * knowledge dimensions have real supporting KnowledgeItem evidence
 * ANYWHERE in the course, and (2) which lessons — regardless of
 * strategy_found — returned genuinely NO extractable knowledge at all
 * (an actual extraction gap, not merely "taught no standalone strategy").
 * The old field names are kept for backward compatibility with existing
 * consumers, but now measure (2) precisely rather than assuming every
 * no_strategy lesson is a gap.
 */
function buildFrameworkCoverage(input: RunSynthesisInput, normalizedKnowledge: NormalizedKnowledge): FrameworkCoverage {
  const byId = new Map(input.lessons.map((l) => [l.id, l]));
  const standaloneStrategyLessonsAnalyzed = new Set(input.instances.map((i) => i.lessonId)).size;

  const itemCountByLesson = new Map<number, number>();
  for (const record of normalizedKnowledge.items) {
    itemCountByLesson.set(record.lessonId, (itemCountByLesson.get(record.lessonId) ?? 0) + 1);
  }
  // A REAL extraction gap: a no_strategy lesson that also returned zero
  // knowledgeItems (e.g. a pre-v2 backward-compat empty record, or a
  // genuinely knowledge-free video) — no longer assumed for every
  // no_strategy lesson, since Phase 3.5A's extractor populates `knowledge`
  // regardless of strategy_found.
  const missingLessons = input.noStandaloneSetupLessonIds
    .map((id) => byId.get(id))
    .filter((l): l is NonNullable<typeof l> => l != null)
    .filter((l) => (itemCountByLesson.get(l.id) ?? 0) === 0);

  const evidenceCountByDimension = new Map<string, number>();
  for (const record of normalizedKnowledge.items) {
    evidenceCountByDimension.set(record.item.category, (evidenceCountByDimension.get(record.item.category) ?? 0) + 1);
  }
  const missingDimensions = COVERAGE_DIMENSIONS.filter((d) => (evidenceCountByDimension.get(d.key) ?? 0) === 0);

  const status: FrameworkCoverage["status"] = missingDimensions.length > 0 || missingLessons.length > 0 ? "PARTIAL" : "COMPLETE";

  const noteParts: string[] = [];
  if (missingDimensions.length > 0) {
    noteParts.push(`No source evidence exists yet for: ${missingDimensions.map((d) => d.label).join(", ")}.`);
  }
  if (missingLessons.length > 0) {
    noteParts.push(`${missingLessons.length} lesson(s) returned no extractable knowledge at all (an extraction gap, not simply "no standalone setup").`);
  }

  return {
    status,
    standaloneStrategyLessonsAnalyzed,
    lessonsWithoutStandaloneSetup: input.noStandaloneSetupLessonIds.length,
    lessonsMissingSupportingKnowledgeExtraction: missingLessons.length,
    missingSupportingKnowledgeLessonIds: missingLessons.map((l) => l.id),
    missingSupportingKnowledgeLessonTitles: missingLessons.map((l) => l.title),
    missingFrameworkDimensions: missingDimensions.map((d) => d.label),
    coverageNote:
      noteParts.length > 0
        ? `Strategy synthesis complete. Course-framework coverage is partial: ${noteParts.join(" ")}`
        : "Strategy synthesis complete. Course-framework coverage is current across every tracked framework dimension.",
  };
}

/**
 * Deterministic, code-generated — never asked of Gemini. Strategy-scoped
 * KnowledgeItems whose scope.strategies name(s) could not be confidently
 * mapped to any canonical-strategy cluster (see strategyScopeMapping.ts),
 * either deterministically or via its Gemini fallback tier. Preserved here
 * rather than silently dropped, and deliberately kept OUT of both the
 * canonical strategies (would be a guess at which one) and the course-wide
 * framework (would misrepresent a strategy-specific rule as universal).
 */
function buildUnmatchedStrategyKnowledgeSection(unmatched: KnowledgeItemRecord[]) {
  const listing = unmatched
    .map((r) => `- [${r.lessonTitle}] "${r.item.statement}" (scoped to: ${r.item.scope.strategies.join(", ")})`)
    .join("\n");
  return {
    key: "unmatched_strategy_scoped_knowledge",
    title: "Unmatched Strategy-Scoped Knowledge",
    content: `The following ${unmatched.length} knowledge item(s) are scoped to a specific strategy by name, but that name could not be confidently matched to any canonical strategy cluster above (neither deterministically nor via a Gemini-assisted match). They are preserved here rather than being dropped or guessed into the wrong strategy.\n\n${listing}`,
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
