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
import { buildClusterCandidates, resolveStrategyScopeNames, type ScopeMappingResult } from "./strategyScopeMapping.js";
import { SynthesisInvariantError } from "./errors.js";
import { collectScopeVocabulary, collectNonGlobalRuleDescriptions } from "./frameworkScopeSplit.js";
import { findUniversalSectionScopeLeaks } from "./universalSectionAudit.js";
import type { KnowledgeItemScope } from "../gemini/schema.js";
import type {
  CanonicalStrategy,
  ClusterProposal,
  CoreFramework,
  CoursePlaybookDocument,
  DecisionFramework,
  FrameworkCoverage,
  PlaybookSection,
  StrategyScopeMappingSummary,
} from "./schema.js";

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
  /**
   * Real-audit fix (Phase 3.5B) — split from a single conflated
   * `contributedStrategyNames` field. A real audit found a lesson with
   * strategy_found=false (e.g. "Stocks") listed as if it taught a
   * standalone strategy ("Stocks: Break and Retest (B&R) Setup") merely
   * because it contributed SUPPORTING knowledge to that strategy —
   * `taughtStrategyNames` is now the standalone-setup provenance
   * (CanonicalStrategy.sourceLessonIds) and `supportingStrategyNames` is
   * the separate supporting-knowledge provenance
   * (CanonicalStrategy.supportingKnowledgeLessonIds); a lesson may
   * legitimately appear in both if it did both.
   */
  taughtStrategyNames: string[];
  supportingStrategyNames: string[];
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
  const { playbook: geminiPlaybook, usage: playbookUsage } = await synthesizePlaybook(
    deps,
    input.courseTitle,
    canonicalStrategies,
    coreFramework,
  );
  usages.push(playbookUsage);

  const frameworkCoverage = buildFrameworkCoverage(input, normalizedKnowledge);
  const strategyScopeMapping = buildStrategyScopeMappingSummary(rawScopeNames, scopeMapping, normalizedKnowledge.strategyScopedItems, unmatchedStrategyKnowledge);

  const librarySection = buildCanonicalStrategyLibrarySection(canonicalStrategies);
  assertCanonicalStrategyLibraryComplete(librarySection, canonicalStrategies);

  // Real-audit fix (Phase 3.5B v3/v4, Blocker B/D-4) — deterministic
  // secondary check that a section using absolute-claim ("all"/"every"/
  // "always"/"universal"/...) language doesn't broaden real scoped/
  // unverified material. Runs across EVERY playbook section (not just
  // "master_trading_checklist" — a real dry run found the leak elsewhere).
  // Two independent signals, both against real, already-known data: (1)
  // literal scope-vocabulary terms (coreFramework AND each canonical
  // strategy's own rule categories), and (2) significant word-overlap with
  // a non-global (SCOPED or UNVERIFIED) rule's own description — see
  // universalSectionAudit.ts and frameworkScopeSplit.ts.
  const scopeVocabulary = collectScopeVocabulary(coreFramework, collectCanonicalStrategyScopes(canonicalStrategies));
  const nonGlobalRuleDescriptions = collectNonGlobalRuleDescriptions(coreFramework, canonicalStrategies);
  const universalSectionScopeLeaks = findUniversalSectionScopeLeaks(geminiPlaybook.sections, scopeVocabulary, nonGlobalRuleDescriptions);

  const playbook: CoursePlaybookDocument = {
    ...geminiPlaybook,
    sections: [
      ...insertCanonicalStrategyLibrarySection(geminiPlaybook.sections, librarySection),
      buildCoverageNotesSection(input, frameworkCoverage, unmatchedStrategyKnowledge.length),
      buildSourceIndexSection(input, canonicalStrategies),
      ...(unmatchedStrategyKnowledge.length > 0 ? [buildUnmatchedStrategyKnowledgeSection(unmatchedStrategyKnowledge)] : []),
    ],
    frameworkCoverage,
    strategyScopeMapping,
    universalSectionScopeLeaks,
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

  // Real-audit fix (Phase 3.5B): the note previously opened with "Strategy
  // synthesis complete", which read as claiming strategy-SCOPE-MAPPING was
  // fully resolved — a real dry run had 11 unmatched strategy-scoped
  // knowledge items while this said exactly that. This note is now scoped
  // STRICTLY to framework-dimension coverage; strategy-scope-mapping
  // completeness is reported separately (see StrategyScopeMappingSummary /
  // buildStrategyScopeMappingSummary) and must never be inferred from this
  // wording either way.
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
        ? `Course-framework coverage is PARTIAL: ${noteParts.join(" ")}`
        : "Course-framework coverage is COMPLETE — every tracked framework dimension has current supporting evidence. (This does not by itself mean every strategy-scoped knowledge item was matched to a canonical strategy — see the separate strategy-scope-mapping summary.)",
  };
}

/**
 * Real-audit fix (Phase 3.5B) — a SEPARATE, independent completeness signal
 * from FrameworkCoverage (see StrategyScopeMappingSummary's doc comment in
 * schema.ts for why these must never be conflated). Reports both at the
 * distinct-raw-name level (e.g. "B&R" and "Break and Retest" are two raw
 * names that may resolve to the same cluster) and the individual-item
 * level, plus the exact unmatched names so a human can review them (see
 * strategyScopeMapping.ts's two-tier resolution — deterministic, then a
 * single batched Gemini fallback call).
 */
function buildStrategyScopeMappingSummary(
  rawScopeNames: string[],
  scopeMapping: ScopeMappingResult,
  strategyScopedItems: KnowledgeItemRecord[],
  unmatchedStrategyKnowledge: KnowledgeItemRecord[],
): StrategyScopeMappingSummary {
  const matchedRawNames = rawScopeNames.filter((name) => scopeMapping.mapped.has(name));
  const unmatchedRawNames = rawScopeNames.filter((name) => !scopeMapping.mapped.has(name));

  return {
    distinctRawNameCount: rawScopeNames.length,
    matchedRawNameCount: matchedRawNames.length,
    unmatchedRawNameCount: unmatchedRawNames.length,
    matchedRawNames,
    unmatchedRawNames,
    totalStrategyScopedItemCount: strategyScopedItems.length,
    matchedItemCount: strategyScopedItems.length - unmatchedStrategyKnowledge.length,
    unmatchedItemCount: unmatchedStrategyKnowledge.length,
    completeness: unmatchedRawNames.length === 0 ? "COMPLETE" : "PARTIAL",
  };
}

/**
 * Real-audit fix (Phase 3.5B, Blocker 1) — a real 28-lesson dry run showed
 * Gemini's own playbook prose miscounting canonical strategies ("The
 * playbook recognizes fifteen canonical strategies" when there were 16,
 * silently omitting one). Completeness of an already-known, enumerable
 * list must never depend on Gemini remembering every item — this section
 * is built DIRECTLY from `canonicalStrategies`, guaranteeing exact 1:1
 * coverage by construction. Gemini is never asked to produce this section
 * (see playbook.ts's REQUIRED_SECTION_KEYS, which no longer includes it).
 */
/** Every canonical-strategy rule category that can carry its own (possibly narrower) `scope`, used by collectCanonicalStrategyScopes below. Mirrors decisionFramework.ts's STRATEGY_RULE_CATEGORIES. */
const CANONICAL_STRATEGY_SCOPED_RULE_CATEGORIES = [
  "marketContext",
  "prerequisites",
  "setup",
  "entryRules",
  "confirmationRules",
  "stopLossRules",
  "profitTargetRules",
  "tradeManagementRules",
  "invalidationRules",
  "noTradeConditions",
  "visualDiscretionaryRules",
  "riskManagementRules",
  "positionSizingRules",
  "scalingInRules",
  "scalingOutRules",
  "runnerManagementRules",
  "warnings",
] as const satisfies readonly (keyof CanonicalStrategy)[];

/**
 * Every real, non-null `scope` carried by any canonical strategy's own
 * rules — fed into collectScopeVocabulary alongside coreFramework's scoped
 * rules so universalSectionAudit.ts's vocabulary check also catches a
 * strategy-specific term (e.g. an options-only or intraday-only phrase from
 * a canonical strategy's own entryRules) leaking into a section claimed
 * universal, not just course-framework-level scoped terms.
 */
function collectCanonicalStrategyScopes(canonicalStrategies: CanonicalStrategy[]): KnowledgeItemScope[] {
  const scopes: KnowledgeItemScope[] = [];
  for (const strategy of canonicalStrategies) {
    for (const category of CANONICAL_STRATEGY_SCOPED_RULE_CATEGORIES) {
      for (const rule of strategy[category]) {
        if (rule.scope) scopes.push(rule.scope);
      }
    }
  }
  return scopes;
}

function buildCanonicalStrategyLibrarySection(canonicalStrategies: CanonicalStrategy[]): PlaybookSection {
  const entries = canonicalStrategies
    .map((strategy, index) => {
      const details: string[] = [];
      if (strategy.purpose) details.push(strategy.purpose);
      if (strategy.markets.length > 0) details.push(`Markets: ${strategy.markets.join(", ")}`);
      if (strategy.timeframes.length > 0) details.push(`Timeframes: ${strategy.timeframes.join(", ")}`);
      if (strategy.instructorPreferences.length > 0) {
        details.push(`Instructor preferences (discretionary, not a hard requirement): ${strategy.instructorPreferences.map((r) => r.description).join("; ")}`);
      }
      return `${index + 1}. **${strategy.name}**${details.length > 0 ? ` — ${details.join(" ")}` : ""}`;
    })
    .join("\n\n");

  return {
    key: "canonical_strategy_library",
    title: "Canonical Strategy Library",
    content: `This course teaches exactly ${canonicalStrategies.length} distinct canonical strategy(ies), generated deterministically from the synthesized canonical-strategy set — this list can never omit, undercount, or overcount a strategy.\n\n${entries}`,
  };
}

/** Inserts the deterministic library section at the same reading position Gemini's own prose would have used ("entry_framework" or later); appends to the front if that key is somehow absent, so the section is never lost. */
function insertCanonicalStrategyLibrarySection(sections: PlaybookSection[], librarySection: PlaybookSection): PlaybookSection[] {
  const index = sections.findIndex((s) => s.key === "entry_framework");
  if (index === -1) return [librarySection, ...sections];
  return [...sections.slice(0, index), librarySection, ...sections.slice(index)];
}

/**
 * Defensive invariant guard (Blocker 1) — should be structurally
 * impossible to trip given buildCanonicalStrategyLibrarySection generates
 * the section directly FROM canonicalStrategies, but exists explicitly per
 * the real-audit requirement to never allow silent omission, including
 * against a future refactor reintroducing the bug.
 */
function assertCanonicalStrategyLibraryComplete(librarySection: PlaybookSection, canonicalStrategies: CanonicalStrategy[]): void {
  for (const strategy of canonicalStrategies) {
    if (!librarySection.content.includes(strategy.name)) {
      throw new SynthesisInvariantError(
        `Canonical Strategy Library section is missing canonical strategy "${strategy.name}" — expected exactly ${canonicalStrategies.length} strategies, this must never happen since the section is generated directly from canonicalStrategies.`,
      );
    }
  }
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
 * Real-audit fix (Phase 3.5B, Blocker 2) — REPLACES the obsolete Phase 3.4
 * version of this section, which said a "No Standalone Setup" lesson is
 * "NOT represented anywhere else in this playbook or Core Framework" and
 * that closing the gap "requires a future supplemental extractor." Both
 * claims are now FALSE: Phase 3.5A already extracts rich knowledge from
 * every lesson regardless of strategy_found, and Phase 3.5B actively
 * synthesizes it into the canonical strategies (supportingKnowledgeLessonIds)
 * and the course-wide framework (courseKnowledge in runSynthesis). This
 * version reports the real, current Phase 3.5B coverage picture instead —
 * deterministic, never asked of Gemini.
 */
function buildCoverageNotesSection(input: RunSynthesisInput, frameworkCoverage: FrameworkCoverage, unmatchedStrategyKnowledgeCount: number) {
  const totalLessons = input.lessons.length;
  const standaloneCount = frameworkCoverage.standaloneStrategyLessonsAnalyzed;
  const noStandaloneCount = frameworkCoverage.lessonsWithoutStandaloneSetup;
  const supportingKnowledgeExtractedCount = noStandaloneCount - frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction;

  const lines = [
    `${totalLessons} lesson(s) analyzed.`,
    `${standaloneCount} lesson(s) taught at least one standalone strategy/setup.`,
    `${noStandaloneCount} lesson(s) taught no standalone setup — this does NOT mean they are unrepresented. Phase 3.5A extracts rich supporting knowledge (risk management, sizing, psychology, market context, execution, and more) from every lesson regardless of whether it teaches a standalone setup, and Phase 3.5B synthesizes that knowledge into the canonical strategies and course-wide framework above.`,
    `${supportingKnowledgeExtractedCount} of those ${noStandaloneCount} lesson(s) successfully contributed extractable supporting knowledge. ${frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction} returned no extractable knowledge at all — a real extraction gap, distinct from simply "no standalone setup".`,
    `${unmatchedStrategyKnowledgeCount} strategy-scoped knowledge item(s) could not be confidently matched to a canonical strategy and are preserved separately (see "Unmatched Strategy-Scoped Knowledge" below) rather than being merged into the wrong strategy or the course-wide framework.`,
    frameworkCoverage.missingFrameworkDimensions.length > 0
      ? `Framework dimensions with no current supporting evidence: ${frameworkCoverage.missingFrameworkDimensions.join(", ")}.`
      : `Every tracked framework dimension has current supporting evidence.`,
  ];

  return {
    key: "coverage_notes",
    title: "Coverage Notes",
    content: lines.join("\n\n"),
  };
}

/**
 * Section 19 — deterministic, not synthesized: a plain listing of every
 * contributing lesson and what it contributed.
 *
 * Real-audit fix (Phase 3.5B, Blocker 3) — a real dry run showed a lesson
 * with strategy_found=false ("Stocks") listed as "Stocks: Break and Retest
 * (B&R) Setup", which reads as if Stocks taught the standalone B&R
 * strategy — it only contributed strategy-SCOPED SUPPORTING KNOWLEDGE to
 * it. Now built from two disjoint-in-intent, both-deterministic
 * CanonicalStrategy fields: `sourceLessonIds` (taught the standalone setup)
 * and `supportingKnowledgeLessonIds` (contributed matched supporting
 * knowledge) — never collapsed into one list again.
 */
function buildSourceIndexSection(input: RunSynthesisInput, canonicalStrategies: CanonicalStrategy[]) {
  const taughtByLesson = new Map<number, string[]>();
  const supportingByLesson = new Map<number, string[]>();
  for (const strategy of canonicalStrategies) {
    for (const lessonId of strategy.sourceLessonIds) {
      const existing = taughtByLesson.get(lessonId) ?? [];
      existing.push(strategy.name);
      taughtByLesson.set(lessonId, existing);
    }
    for (const lessonId of strategy.supportingKnowledgeLessonIds) {
      const existing = supportingByLesson.get(lessonId) ?? [];
      existing.push(strategy.name);
      supportingByLesson.set(lessonId, existing);
    }
  }

  const entries: SourceIndexEntry[] = input.lessons.map((lesson) => ({
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    chapterTitle: lesson.chapterTitle,
    sourceUrl: lesson.sourceUrl,
    taughtStrategyNames: taughtByLesson.get(lesson.id) ?? [],
    supportingStrategyNames: supportingByLesson.get(lesson.id) ?? [],
  }));

  const content = entries
    .map((e) => {
      const taught = e.taughtStrategyNames.length > 0 ? e.taughtStrategyNames.join(", ") : "none";
      const supportingLine =
        e.supportingStrategyNames.length > 0 ? `\n    Supporting canonical strategy knowledge: ${e.supportingStrategyNames.join(", ")}` : "";
      return `- ${e.lessonTitle}${e.chapterTitle ? ` (${e.chapterTitle})` : ""}\n    Standalone strategies taught: ${taught}${supportingLine}`;
    })
    .join("\n");

  return { key: "source_index", title: "Source Index", content };
}
