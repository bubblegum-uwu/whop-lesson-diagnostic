import { z } from "zod";
import { NumericalValueSchema, KnowledgeItemScopeSchema } from "../gemini/schema.js";

/**
 * Zod schemas for every Gemini-produced synthesis artifact (Stages 2-6),
 * mirroring the pattern in gemini/schema.ts: Gemini's raw JSON text is
 * parsed against these before anything is persisted, and a hand-kept JSON
 * Schema mirror of each is passed as `response_format.schema` so the model
 * is constrained to produce compatible output. Keep each pair in sync.
 */

// ---- Shared provenance / rule shapes -------------------------------------

// `.nullable().optional().transform((v) => v ?? null)` keeps the inferred
// TS type exactly `T | null` (so nothing downstream needs to change) while
// accepting a field Gemini omits entirely — see the matching JSON schema
// below, which represents "nullable" by leaving the field out of
// `required` rather than `type: [T, "null"]`. Google's structured-output
// docs do document `type: [T, "null"]` as supported, so this is NOT a
// confirmed Gemini incompatibility fix — the production 400's actual
// cause is still unknown (the original error handling lost which stage
// even failed). This is kept as a harmless simplification/compatibility
// hardening because omission-from-`required` is semantically equivalent
// and strictly simpler for Gemini to satisfy, not because the array form
// was shown to be rejected.
const nullableString = () => z.string().nullable().optional().transform((v) => v ?? null);
const nullableNumber = () => z.number().nullable().optional().transform((v) => v ?? null);

export const SourceRefSchema = z.object({
  lessonId: z.number(),
  lessonTitle: z.string(),
  strategyInstanceId: nullableNumber(),
  startTimestamp: nullableString(),
  endTimestamp: nullableString(),
  evidence: z.string(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SupportLevel = z.enum([
  "SINGLE_SOURCE",
  "MULTI_SOURCE",
  "REPEATED_EXPLICIT",
  "VARIANT",
  "CONFLICTING",
  "INFERRED",
]);
export type SupportLevelValue = z.infer<typeof SupportLevel>;

export const SynthesizedRuleSchema = z.object({
  description: z.string().min(1),
  classification: z.enum(["explicit", "inferred", "visual", "synthesized"]),
  supportLevel: SupportLevel,
  supportCount: z.number().int().min(0),
  sources: z.array(SourceRefSchema),
  conflictSources: z.array(SourceRefSchema),
  /**
   * Phase 3.5B additive fields — NEVER asked of Gemini directly (no wire
   * schema requires them); populated deterministically by enrichment code
   * from the KnowledgeItem(s) a rule's sourceKeys/conflictSourceKeys cite
   * (see sourceRegistry.ts), the same "don't make Gemini reproduce data the
   * application already has" principle this file already applies to
   * provenance. Default [] / null for every rule not derived from a
   * knowledge citation (e.g. the pre-3.5B strategy-instance-only
   * categories), so no existing behavior changes for those.
   */
  exceptions: z.array(z.string()).optional().default([]),
  numericalValues: z.array(NumericalValueSchema).optional().default([]),
  /** The union of every cited KnowledgeItem's scope — null when this rule carries no scope-bearing citation. Preserves instrument/timeframe/session/traderProfile restrictions that must survive synthesis rather than being flattened into a universal rule. */
  scope: KnowledgeItemScopeSchema.nullable().optional().default(null),
});
export type SynthesizedRule = z.infer<typeof SynthesizedRuleSchema>;

export const ConflictSchema = z.object({
  description: z.string().min(1),
  sources: z.array(SourceRefSchema),
});
export type Conflict = z.infer<typeof ConflictSchema>;

// Nullable fields are represented by omission from `required`, NOT
// `type: [T, "null"]` — kept as a simplification/compatibility hardening
// (semantically equivalent, strictly simpler), not because the array form
// was confirmed to cause the production 400. Google's own docs list
// `type: [T, "null"]` as supported, so it is not the confirmed root cause.
const sourceRefJsonSchema = {
  type: "object",
  properties: {
    lessonId: { type: "number" },
    lessonTitle: { type: "string" },
    strategyInstanceId: { type: "number" },
    startTimestamp: { type: "string" },
    endTimestamp: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["lessonId", "lessonTitle", "evidence"],
};

const synthesizedRuleJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    classification: { type: "string", enum: ["explicit", "inferred", "visual", "synthesized"] },
    supportLevel: {
      type: "string",
      enum: ["SINGLE_SOURCE", "MULTI_SOURCE", "REPEATED_EXPLICIT", "VARIANT", "CONFLICTING", "INFERRED"],
    },
    supportCount: { type: "integer" },
    sources: { type: "array", items: sourceRefJsonSchema },
    conflictSources: { type: "array", items: sourceRefJsonSchema },
  },
  required: ["description", "classification", "supportLevel", "supportCount", "sources", "conflictSources"],
};
const synthesizedRuleArray = { type: "array", items: synthesizedRuleJsonSchema };

const conflictJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    sources: { type: "array", items: sourceRefJsonSchema },
  },
  required: ["description", "sources"],
};

// ---- Stage 2: clustering --------------------------------------------------

export const ClusterProposalSchema = z.object({
  clusterKey: z.string().min(1),
  proposedCanonicalName: z.string().min(1),
  memberInstanceIds: z.array(z.number()).min(1),
  similarityRationale: z.string(),
  differencesNotes: z.string(),
});
export type ClusterProposal = z.infer<typeof ClusterProposalSchema>;

export const ClusterBatchResultSchema = z.object({
  clusters: z.array(ClusterProposalSchema),
});
export type ClusterBatchResult = z.infer<typeof ClusterBatchResultSchema>;

const clusterProposalJsonSchema = {
  type: "object",
  properties: {
    clusterKey: { type: "string" },
    proposedCanonicalName: { type: "string" },
    memberInstanceIds: { type: "array", items: { type: "number" } },
    similarityRationale: { type: "string" },
    differencesNotes: { type: "string" },
  },
  required: ["clusterKey", "proposedCanonicalName", "memberInstanceIds", "similarityRationale", "differencesNotes"],
};

export const CLUSTER_BATCH_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: { clusters: { type: "array", items: clusterProposalJsonSchema } },
  required: ["clusters"],
};

// Reduce step (merging multiple chunks' cluster proposals) uses the same shape.
export const CLUSTER_MERGE_RESPONSE_JSON_SCHEMA = CLUSTER_BATCH_RESPONSE_JSON_SCHEMA;

// ---- Stage 3: canonical strategy ------------------------------------------

export const VariantSchema = z.object({
  description: z.string().min(1),
  sourceLessonIds: z.array(z.number()),
});

export const ExampleSchema = z.object({
  description: z.string().min(1),
  sourceLessonId: z.number(),
});

export const CanonicalStrategySchema = z.object({
  name: z.string().min(1),
  purpose: z.string(),
  markets: z.array(z.string()),
  timeframes: z.array(z.string()),
  marketContext: z.array(SynthesizedRuleSchema),
  prerequisites: z.array(SynthesizedRuleSchema),
  setup: z.array(SynthesizedRuleSchema),
  entryRules: z.array(SynthesizedRuleSchema),
  confirmationRules: z.array(SynthesizedRuleSchema),
  stopLossRules: z.array(SynthesizedRuleSchema),
  profitTargetRules: z.array(SynthesizedRuleSchema),
  tradeManagementRules: z.array(SynthesizedRuleSchema),
  invalidationRules: z.array(SynthesizedRuleSchema),
  noTradeConditions: z.array(SynthesizedRuleSchema),
  visualDiscretionaryRules: z.array(SynthesizedRuleSchema),
  /**
   * Phase 3.5B additive categories — populated from strategy-scoped rich
   * KnowledgeItems (see strategyScopeMapping.ts) drawn from ANY contributing
   * lesson, not just the cluster's own strategy_instances rows. Same
   * SynthesizedRule shape as the 11 categories above; defaults to [] for a
   * cluster with no matching knowledge, so this is purely additive to
   * existing consumers (a canonical strategy already worked with these
   * absent — it just wasn't as rich as the source material allowed).
   */
  riskManagementRules: z.array(SynthesizedRuleSchema).optional().default([]),
  positionSizingRules: z.array(SynthesizedRuleSchema).optional().default([]),
  scalingInRules: z.array(SynthesizedRuleSchema).optional().default([]),
  scalingOutRules: z.array(SynthesizedRuleSchema).optional().default([]),
  runnerManagementRules: z.array(SynthesizedRuleSchema).optional().default([]),
  warnings: z.array(SynthesizedRuleSchema).optional().default([]),
  instructorPreferences: z.array(SynthesizedRuleSchema).optional().default([]),
  variants: z.array(VariantSchema),
  examples: z.array(ExampleSchema),
  ambiguities: z.array(z.string()),
  conflicts: z.array(ConflictSchema),
  /**
   * Real-audit fix (Phase 3.5B) — lessons whose STANDALONE STRATEGY INSTANCE
   * is a member of this cluster (i.e. this lesson taught the setup itself).
   * Computed DETERMINISTICALLY by enrichCanonicalStrategy from `members`,
   * never asked of or trusted from Gemini — a real audit found Gemini's own
   * `sourceLessonIds` conflating "taught this strategy" with "contributed
   * supporting knowledge to this strategy" (e.g. a lesson with
   * strategy_found=false, contributing only strategy-scoped knowledge,
   * showing up here as if it taught the setup). See
   * `supportingKnowledgeLessonIds` for the separate, second concept.
   */
  sourceLessonIds: z.array(z.number()),
  /**
   * Real-audit fix (Phase 3.5B) — lessons that contributed strategy-scoped
   * supporting KnowledgeItems to this cluster (via strategyScopeMapping.ts)
   * WITHOUT themselves teaching the standalone strategy — e.g. a lesson on
   * general market context that happens to mention "with Break & Retest,
   * risk 1%". Computed deterministically from `scopedKnowledge`, never from
   * Gemini. Disjoint in intent from `sourceLessonIds`, though the same
   * lesson id may legitimately appear in both if it both taught the setup
   * AND separately contributed matched scoped knowledge.
   */
  supportingKnowledgeLessonIds: z.array(z.number()).optional().default([]),
});
export type CanonicalStrategy = z.infer<typeof CanonicalStrategySchema>;

const variantJsonSchema = {
  type: "object",
  properties: { description: { type: "string" }, sourceLessonIds: { type: "array", items: { type: "number" } } },
  required: ["description", "sourceLessonIds"],
};
const exampleJsonSchema = {
  type: "object",
  properties: { description: { type: "string" }, sourceLessonId: { type: "number" } },
  required: ["description", "sourceLessonId"],
};

export const CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    purpose: { type: "string" },
    markets: { type: "array", items: { type: "string" } },
    timeframes: { type: "array", items: { type: "string" } },
    marketContext: synthesizedRuleArray,
    prerequisites: synthesizedRuleArray,
    setup: synthesizedRuleArray,
    entryRules: synthesizedRuleArray,
    confirmationRules: synthesizedRuleArray,
    stopLossRules: synthesizedRuleArray,
    profitTargetRules: synthesizedRuleArray,
    tradeManagementRules: synthesizedRuleArray,
    invalidationRules: synthesizedRuleArray,
    noTradeConditions: synthesizedRuleArray,
    visualDiscretionaryRules: synthesizedRuleArray,
    variants: { type: "array", items: variantJsonSchema },
    examples: { type: "array", items: exampleJsonSchema },
    ambiguities: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: conflictJsonSchema },
    sourceLessonIds: { type: "array", items: { type: "number" } },
  },
  required: [
    "name",
    "purpose",
    "markets",
    "timeframes",
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
    "variants",
    "examples",
    "ambiguities",
    "conflicts",
    "sourceLessonIds",
  ],
};

// ---- Stage 3 raw wire format ------------------------------------------------
//
// v2 (superseded): asked Gemini for 11 separate sibling arrays — one per
// rule category — each an array of the full nested rule/source shape. A
// real-Gemini smoke test (tests/synthesisRealApiSmoke.test.ts) confirmed
// that schema IS rejected with a 400 by the actual API, not just a
// theoretical risk. Because these 11 properties are written out as
// separate JSON Schema object literals (JSON has no $ref-sharing on the
// wire — each of the 11 is a full independent copy when serialized), the
// v2 schema included roughly 11x more copies of the same deeply nested
// rule/source shape than necessary.
//
// v3 (superseded for sources/conflictSources — see v4 below): collapsed
// the 11 sibling arrays into a SINGLE `sections` array, each entry tagged
// with which of the 11 categories it belongs to — the same information,
// restructured so the nested rule shape appears exactly once in the schema
// instead of eleven times. Every rule's `sources`/`conflictSources` still
// asked Gemini to RESTATE lessonId + timestamps + evidence text per source
// citation (only lessonTitle/strategyInstanceId were already elided,
// filled in deterministically afterward).
//
// v4 (current) — root-cause fix for real output-token amplification, not
// just a bigger budget: a real diagnostic run against the actual first
// production cluster ("Break and Retest (B&R) with Key Levels and Order
// Blocks", a ONE-MEMBER cluster) showed canonical_strategy producing
// output_tokens=31032/thinking_tokens=17222 against a 32768-token budget —
// abnormally large for a single lesson's already-known rules. Root cause:
// every source citation required Gemini to RE-EMIT evidence text (a
// quoted sentence, potentially tens of tokens) that was ALREADY present,
// verbatim, in the prompt's input (see gemini/schema.ts's RuleSchema —
// every original Stage-1 rule already carries its own lessonId/
// timestamps/evidence). Gemini was being asked to copy text it had
// already read back out as generated output, once per source citation,
// for potentially every synthesized rule.
//
// v4 assigns each individual ORIGINAL Stage-1 rule (across all of a
// cluster's members) a short, stable reference "key" (e.g. "s7") when
// building the prompt (see canonicalStrategy.ts's keySourceData) — Gemini
// now cites WHICH original rule(s) support a synthesized rule via
// "sourceKeys"/"conflictSourceKeys" (short string arrays) instead of
// restating lessonId, timestamps, and evidence per citation. Application
// code (canonicalStrategy.ts's enrichCanonicalStrategy) resolves each key
// back to the exact lessonId/strategyInstanceId/timestamps/evidence using
// data already known BEFORE the Gemini call — never re-derived, never
// fabricated. This also makes strategyInstanceId attribution exact in
// every case (previously left null when a lesson contributed more than
// one instance to a cluster, since lessonId alone was ambiguous — a key
// now points at one specific instance's one specific rule, so there's
// nothing to disambiguate).
//
// No provenance, conflict, or persisted field is dropped by any of this —
// only how Gemini's own output cites its sources changed; the final,
// persisted CanonicalStrategy shape/CanonicalStrategySchema above is
// completely untouched, and still carries the full SourceRef object
// (lessonId/lessonTitle/strategyInstanceId/timestamps/evidence) for every
// rule and conflict.

const rawSynthesizedRuleJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    classification: { type: "string", enum: ["explicit", "inferred", "visual", "synthesized"] },
    supportLevel: {
      type: "string",
      enum: ["SINGLE_SOURCE", "MULTI_SOURCE", "REPEATED_EXPLICIT", "VARIANT", "CONFLICTING", "INFERRED"],
    },
    supportCount: { type: "integer" },
    sourceKeys: { type: "array", items: { type: "string" } },
    conflictSourceKeys: { type: "array", items: { type: "string" } },
  },
  required: ["description", "classification", "supportLevel", "supportCount", "sourceKeys", "conflictSourceKeys"],
};
const rawSynthesizedRuleArray = { type: "array", items: rawSynthesizedRuleJsonSchema };

export const RawSynthesizedRuleSchema = SynthesizedRuleSchema.omit({ sources: true, conflictSources: true }).extend({
  /** Reference keys (e.g. "s7") into the original per-rule data Gemini was shown for this cluster's members — resolved to full SourceRef objects by canonicalStrategy.ts's enrichCanonicalStrategy. An unknown key is dropped defensively, never fabricated into a source. */
  sourceKeys: z.array(z.string()),
  conflictSourceKeys: z.array(z.string()),
});
export type RawSynthesizedRule = z.infer<typeof RawSynthesizedRuleSchema>;

const rawConflictJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    sourceKeys: { type: "array", items: { type: "string" } },
  },
  required: ["description", "sourceKeys"],
};

export const RawConflictSchema = z.object({
  description: z.string().min(1),
  sourceKeys: z.array(z.string()),
});
export type RawConflict = z.infer<typeof RawConflictSchema>;

/**
 * The CanonicalStrategy rule-category keys — see CanonicalStrategySchema
 * above. Exported so canonicalStrategy.ts's enrichment step can iterate them
 * without re-listing them a third time. The last 7 are Phase 3.5B additions
 * (populated from strategy-scoped rich KnowledgeItems, not strategy_instances
 * rules) — added to the SAME enum/sections mechanism rather than a parallel
 * one, since that mechanism (schema.ts's v3 changelog) already exists
 * specifically to let Gemini tag an arbitrary rule with its category without
 * needing N separate sibling JSON Schema arrays.
 */
export const RULE_CATEGORY_KEYS = [
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
  "instructorPreferences",
] as const;
export type RuleCategoryKey = (typeof RULE_CATEGORY_KEYS)[number];

export const RawRuleSectionSchema = z.object({
  category: z.enum(RULE_CATEGORY_KEYS),
  rules: z.array(RawSynthesizedRuleSchema),
});
export type RawRuleSection = z.infer<typeof RawRuleSectionSchema>;

const rawRuleSectionJsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...RULE_CATEGORY_KEYS] },
    rules: rawSynthesizedRuleArray,
  },
  required: ["category", "rules"],
};

export const RawCanonicalStrategySchema = CanonicalStrategySchema.omit({
  marketContext: true,
  prerequisites: true,
  setup: true,
  entryRules: true,
  confirmationRules: true,
  stopLossRules: true,
  profitTargetRules: true,
  tradeManagementRules: true,
  invalidationRules: true,
  noTradeConditions: true,
  visualDiscretionaryRules: true,
  riskManagementRules: true,
  positionSizingRules: true,
  scalingInRules: true,
  scalingOutRules: true,
  runnerManagementRules: true,
  warnings: true,
  instructorPreferences: true,
  conflicts: true,
  // Real-audit fix (Phase 3.5B) — sourceLessonIds/supportingKnowledgeLessonIds
  // are now ALWAYS computed deterministically by enrichCanonicalStrategy from
  // `members`/`scopedKnowledge` (never trusted from Gemini's own output — a
  // real audit found Gemini conflating "taught this strategy" with
  // "contributed supporting knowledge to it" in this exact field). Omitted
  // here so Gemini is never even asked for them.
  sourceLessonIds: true,
  supportingKnowledgeLessonIds: true,
}).extend({
  sections: z.array(RawRuleSectionSchema),
  conflicts: z.array(RawConflictSchema),
});
export type RawCanonicalStrategy = z.infer<typeof RawCanonicalStrategySchema>;

export const RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    purpose: { type: "string" },
    markets: { type: "array", items: { type: "string" } },
    timeframes: { type: "array", items: { type: "string" } },
    sections: { type: "array", items: rawRuleSectionJsonSchema },
    variants: { type: "array", items: variantJsonSchema },
    examples: { type: "array", items: exampleJsonSchema },
    ambiguities: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: rawConflictJsonSchema },
  },
  required: ["name", "purpose", "markets", "timeframes", "sections", "variants", "examples", "ambiguities", "conflicts"],
};

// ---- Stage 4: core framework ----------------------------------------------

export const CoreFrameworkSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  rules: z.array(SynthesizedRuleSchema),
});

export const CoreFrameworkSchema = z.object({
  sections: z.array(CoreFrameworkSectionSchema),
});
export type CoreFramework = z.infer<typeof CoreFrameworkSchema>;

export const CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, title: { type: "string" }, rules: synthesizedRuleArray },
        required: ["key", "title", "rules"],
      },
    },
  },
  required: ["sections"],
};

/**
 * Phase 3.5B — keyed wire format for core framework, same "sourceKeys
 * instead of restated evidence" pattern canonical_strategy already uses
 * (schema.ts's v4 changelog). Introduced because Phase 3.5B roughly
 * doubles/triples this stage's pooled input (adding ~300-500 course-wide
 * KnowledgeItems on top of the existing pooled cross-strategy rules) — the
 * same shared thinking/output-budget risk that caused canonical_strategy's
 * real truncation failure applies here too if every rule keeps restating
 * full source citations. The final persisted CoreFrameworkSchema shape
 * above is unchanged; only how Gemini's own output cites sources changed.
 */
export const RawCoreFrameworkSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  rules: z.array(RawSynthesizedRuleSchema),
});
export const RawCoreFrameworkSchema = z.object({
  sections: z.array(RawCoreFrameworkSectionSchema),
});
export type RawCoreFramework = z.infer<typeof RawCoreFrameworkSchema>;

const rawCoreFrameworkSectionJsonSchema = {
  type: "object",
  properties: { key: { type: "string" }, title: { type: "string" }, rules: rawSynthesizedRuleArray },
  required: ["key", "title", "rules"],
};

export const RAW_CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    sections: { type: "array", items: rawCoreFrameworkSectionJsonSchema },
  },
  required: ["sections"],
};

// ---- Stage 5: comprehensive playbook --------------------------------------

export const PlaybookSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
});
export type PlaybookSection = z.infer<typeof PlaybookSectionSchema>;

export const PlaybookSchema = z.object({
  title: z.string().min(1),
  sections: z.array(PlaybookSectionSchema),
  conflictsAndAmbiguities: z.array(ConflictSchema),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

export const PLAYBOOK_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string" }, title: { type: "string" }, content: { type: "string" } },
        required: ["key", "title", "content"],
      },
    },
    conflictsAndAmbiguities: { type: "array", items: conflictJsonSchema },
  },
  required: ["title", "sections", "conflictsAndAmbiguities"],
};

// ---- Framework coverage metadata (code-generated, never sent to/from Gemini) ----

/**
 * NEVER produced by Gemini and never validated against a Gemini response —
 * this is computed deterministically from what we actually know was
 * extracted (see runSynthesis.ts's buildFrameworkCoverage), specifically so
 * the synthesis result can never silently present itself as more complete
 * than the underlying evidence supports. `status` is PARTIAL whenever any
 * "No Standalone Setup" lesson hasn't been processed by a supplemental
 * knowledge extractor — which, today, is every one of them, since that
 * extractor doesn't exist yet in this codebase. Never infers or fabricates
 * risk/sizing/psychology content from a lesson's title or absence of data.
 */
export const FrameworkCoverageSchema = z.object({
  status: z.enum(["COMPLETE", "PARTIAL"]),
  standaloneStrategyLessonsAnalyzed: z.number().int().min(0),
  lessonsWithoutStandaloneSetup: z.number().int().min(0),
  lessonsMissingSupportingKnowledgeExtraction: z.number().int().min(0),
  missingSupportingKnowledgeLessonIds: z.array(z.number()),
  missingSupportingKnowledgeLessonTitles: z.array(z.string()),
  /** Phase 3.5B — human-readable labels of the tracked knowledge dimensions (risk management, position sizing, psychology, etc.) with zero supporting evidence anywhere in the course. This, not lesson/strategy counts, is what now drives `status` — see runSynthesis.ts's buildFrameworkCoverage. */
  missingFrameworkDimensions: z.array(z.string()).optional().default([]),
  coverageNote: z.string(),
});
export type FrameworkCoverage = z.infer<typeof FrameworkCoverageSchema>;

/**
 * Real-audit fix (Phase 3.5B) — a real 28-lesson dry run's coverageNote said
 * "Strategy synthesis complete" while 11 strategy-scoped knowledge items
 * remained unmatched to any canonical strategy, which reads as (falsely)
 * implying strategy-scope mapping had fully resolved. This is a SEPARATE,
 * independent concept from FrameworkCoverage — frameworkCoverage.status
 * tracks whether the 13 tracked KNOWLEDGE DIMENSIONS have supporting
 * evidence; this tracks whether every distinct strategy name referenced by
 * scope.strategies was successfully resolved to a canonical-strategy
 * cluster (see strategyScopeMapping.ts). A course can legitimately be
 * FrameworkCoverage.COMPLETE while StrategyScopeMappingSummary is PARTIAL,
 * or vice versa — neither should ever be inferred from the other's wording.
 */
export const StrategyScopeMappingSummarySchema = z.object({
  distinctRawNameCount: z.number().int().min(0),
  matchedRawNameCount: z.number().int().min(0),
  unmatchedRawNameCount: z.number().int().min(0),
  matchedRawNames: z.array(z.string()),
  unmatchedRawNames: z.array(z.string()),
  totalStrategyScopedItemCount: z.number().int().min(0),
  matchedItemCount: z.number().int().min(0),
  unmatchedItemCount: z.number().int().min(0),
  /** COMPLETE only when every distinct raw strategy-scope name resolved — completely independent of FrameworkCoverage.status. */
  completeness: z.enum(["COMPLETE", "PARTIAL"]),
});
export type StrategyScopeMappingSummary = z.infer<typeof StrategyScopeMappingSummarySchema>;

/**
 * Real-audit fix (Phase 3.5B v3, Blocker B) — a SECOND real dry run showed
 * "Master Trading Checklist" claiming to apply "before, during, and after
 * every trading session" while actually containing intraday/equities/
 * options-only steps (session windows, PMH/PML, 1-5 minute execution,
 * options contract rules). The primary fix is architectural (playbook.ts
 * now shows Gemini ONLY genuinely global rules for this section — see
 * frameworkScopeSplit.ts); this is the deterministic secondary safety net,
 * since prose (unlike a decision graph) has no citation mechanism to
 * validate by lineage alone. Best-effort: flags a universal-labeled
 * section whose text contains a term drawn from a REAL scoped rule's own
 * scope arrays (instrument/session/timeframe/trader-profile values) —
 * never generic NLP classification, per this codebase's stated preference
 * for a safer data-lineage-adjacent check over free-text understanding.
 */
export const UniversalSectionScopeLeakSchema = z.object({
  sectionKey: z.string(),
  matchedTerms: z.array(z.string()),
});
export type UniversalSectionScopeLeak = z.infer<typeof UniversalSectionScopeLeakSchema>;

/** The final, persisted playbook document: Gemini's validated Playbook plus code-generated coverage metadata and sections (Canonical Strategy Library, Coverage Notes, Source Index — see runSynthesis.ts). */
export interface CoursePlaybookDocument extends Playbook {
  frameworkCoverage: FrameworkCoverage;
  strategyScopeMapping: StrategyScopeMappingSummary;
  universalSectionScopeLeaks: UniversalSectionScopeLeak[];
}

// ---- Stage 6: master decision framework -----------------------------------

/**
 * Real-audit fix (Phase 3.5B v3, Blockers A/C/D) — a SECOND real 28-lesson
 * dry run found that self-reported `scope` (the v2 fix above, now
 * superseded) was itself unreliable: Gemini placed a stock/equity-specific
 * "Is Stock In Play?" gate before strategy selection with EMPTY scope
 * arrays (a false negative for the leak detector), and separately produced
 * a "minimum 2R target" decision node with empty/global scope even though
 * the single CoreFramework rule it was clearly drawn from carried
 * `marketsOrInstruments: ["options"], traderProfiles: ["beginner"]` — an
 * internal fidelity disagreement between the structured rule and the
 * decision node built from it.
 *
 * Root cause: asking Gemini to self-report a node's scope is exactly the
 * same "make Gemini reproduce/re-derive data it shouldn't own" mistake
 * this codebase already fixed once for SynthesizedRule (see that schema's
 * own doc comment) — just reintroduced here for decision nodes. The fix is
 * the same fix: NEVER ask for scope directly. Gemini instead cites
 * "sourceKeys" — the exact source-pool key(s) (see decisionFramework.ts's
 * buildDecisionSourcePool, which keys every CoreFramework and canonical-
 * strategy rule) a node is built from. `scope` is then computed
 * deterministically as the union of the cited rules' OWN already-known
 * scope — it is now IMPOSSIBLE for a decision node to disagree with its
 * structured source, and a node citing nothing has provably NOT been shown
 * to be global (see decisionScopeAudit.ts, which now flags this "ungrounded"
 * case in addition to a genuinely-scoped-but-placed-as-global one).
 */
export const RawDecisionNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["start", "decision", "action", "end"]),
  label: z.string().min(1),
  description: nullableString(),
  next: z.array(z.string()),
  branches: z.array(z.object({ label: z.string(), next: z.string() })),
  /**
   * The source-pool key(s) this node is built from — see
   * decisionFramework.ts's buildDecisionSourcePool. Empty is legitimate
   * ONLY for a "start"/"end" node or a "decision" node that purely presents
   * a branching question (never asserts a rule itself) — every other node
   * MUST cite at least one key, or decisionScopeAudit.ts's
   * findGlobalGateScopeLeaks will flag it as an unproven ("ungrounded")
   * global claim when it sits on the unconditional pre-strategy-selection
   * path. An unrecognized/invented key is dropped, never fabricated into a
   * scope contribution — mirrors canonicalStrategy.ts's resolveSourceKeys.
   */
  sourceKeys: z.array(z.string()),
});
export type RawDecisionNode = z.infer<typeof RawDecisionNodeSchema>;

export const RawDecisionFrameworkSchema = z.object({
  nodes: z.array(RawDecisionNodeSchema),
  readableSteps: z.array(z.string()),
});
export type RawDecisionFramework = z.infer<typeof RawDecisionFrameworkSchema>;

export const DecisionNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["start", "decision", "action", "end"]),
  label: z.string().min(1),
  description: nullableString(),
  next: z.array(z.string()),
  branches: z.array(z.object({ label: z.string(), next: z.string() })),
  /** The validated (unknown keys dropped) citations this node's scope was derived from — kept for transparency/auditability, never re-trusted as authoritative on its own (see `scope`, which is the actual derived value). */
  sourceKeys: z.array(z.string()),
  /** Deterministically derived as the union of every cited source's own scope — see decisionFramework.ts. Every array empty means genuinely global; this can never disagree with the structured rule(s) it was built from, because it IS those rules' own scope, not a re-statement of it. */
  scope: KnowledgeItemScopeSchema,
});
export type DecisionNode = z.infer<typeof DecisionNodeSchema>;

export const DecisionNodeScopeLeakSchema = z.object({
  nodeId: z.string(),
  label: z.string(),
  /** "ungrounded" = cited no source at all, so it was never proven global; "scoped_source" = its derived scope (from real citations) is non-empty, so it must not sit on the unconditional pre-strategy path. */
  reason: z.enum(["ungrounded", "scoped_source"]),
  scope: KnowledgeItemScopeSchema,
});
export type DecisionNodeScopeLeak = z.infer<typeof DecisionNodeScopeLeakSchema>;

export const DecisionFrameworkSchema = z.object({
  nodes: z.array(DecisionNodeSchema),
  readableSteps: z.array(z.string()),
  /**
   * Deterministic, computed by decisionScopeAudit.ts's
   * findGlobalGateScopeLeaks AFTER citations are resolved — never asked of
   * or trusted from Gemini itself. Should be empty by construction once
   * the citation-based prompt holds, but is reported rather than silently
   * trusted, exactly like `unmatched_strategy_scoped_knowledge` elsewhere
   * in this codebase never silently drops what it can't confidently place.
   */
  scopeLeaks: z.array(DecisionNodeScopeLeakSchema).optional().default([]),
});
export type DecisionFramework = z.infer<typeof DecisionFrameworkSchema>;

export const RAW_DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["start", "decision", "action", "end"] },
          label: { type: "string" },
          description: { type: "string" },
          next: { type: "array", items: { type: "string" } },
          branches: {
            type: "array",
            items: {
              type: "object",
              properties: { label: { type: "string" }, next: { type: "string" } },
              required: ["label", "next"],
            },
          },
          sourceKeys: { type: "array", items: { type: "string" } },
        },
        required: ["id", "type", "label", "next", "branches", "sourceKeys"],
      },
    },
    readableSteps: { type: "array", items: { type: "string" } },
  },
  required: ["nodes", "readableSteps"],
};
