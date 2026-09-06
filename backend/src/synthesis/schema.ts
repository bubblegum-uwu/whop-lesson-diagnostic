import { z } from "zod";

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
  variants: z.array(VariantSchema),
  examples: z.array(ExampleSchema),
  ambiguities: z.array(z.string()),
  conflicts: z.array(ConflictSchema),
  sourceLessonIds: z.array(z.number()),
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
// v2 (the previous shape here) asked Gemini for 11 separate sibling arrays
// — one per rule category — each an array of the full nested rule/source
// shape. A real-Gemini smoke test (tests/synthesisRealApiSmoke.test.ts)
// confirmed that schema IS rejected with a 400 by the actual API, not just
// a theoretical risk. Because these 11 properties are written out as
// separate JSON Schema object literals (JSON has no $ref-sharing on the
// wire — each of the 11 is a full independent copy when serialized), the
// v2 schema included roughly 11x more copies of the same deeply nested
// rule/source shape than necessary. v3 collapses them into a SINGLE
// `sections` array, each entry tagged with which of the 11 categories it
// belongs to — the same information, restructured so the nested rule shape
// appears exactly once in the schema instead of eleven times. This has not
// itself been re-verified against the real API in this environment (no
// Gemini API key available here) — see the PR for the exact command to
// confirm it, and tests/synthesisRealApiSmoke.test.ts's bisection ladder
// for isolating exactly which structural factor (duplication count, nested
// depth, sources vs conflictSources, enums) was actually responsible.
//
// Every rule's `sources`/`conflictSources` still only need lessonId +
// timestamps + evidence; lessonTitle and strategyInstanceId — already
// known for every member of this cluster — are filled in deterministically
// by canonicalStrategy.ts's enrichment step, same as v2. No provenance,
// conflict, or persisted field is dropped by any of this — only how
// Gemini's own output is grouped changed; the final, persisted
// CanonicalStrategy shape/CanonicalStrategySchema above is untouched.

const rawSourceRefJsonSchema = {
  type: "object",
  properties: {
    lessonId: { type: "number" },
    startTimestamp: { type: "string" },
    endTimestamp: { type: "string" },
    evidence: { type: "string" },
  },
  required: ["lessonId", "evidence"],
};

export const RawSourceRefSchema = z.object({
  lessonId: z.number(),
  startTimestamp: nullableString(),
  endTimestamp: nullableString(),
  evidence: z.string(),
});
export type RawSourceRef = z.infer<typeof RawSourceRefSchema>;

const rawSynthesizedRuleJsonSchema = {
  ...synthesizedRuleJsonSchema,
  properties: {
    ...synthesizedRuleJsonSchema.properties,
    sources: { type: "array", items: rawSourceRefJsonSchema },
    conflictSources: { type: "array", items: rawSourceRefJsonSchema },
  },
};
const rawSynthesizedRuleArray = { type: "array", items: rawSynthesizedRuleJsonSchema };

export const RawSynthesizedRuleSchema = SynthesizedRuleSchema.extend({
  sources: z.array(RawSourceRefSchema),
  conflictSources: z.array(RawSourceRefSchema),
});
export type RawSynthesizedRule = z.infer<typeof RawSynthesizedRuleSchema>;

const rawConflictJsonSchema = {
  ...conflictJsonSchema,
  properties: { ...conflictJsonSchema.properties, sources: { type: "array", items: rawSourceRefJsonSchema } },
};

export const RawConflictSchema = z.object({
  description: z.string().min(1),
  sources: z.array(RawSourceRefSchema),
});
export type RawConflict = z.infer<typeof RawConflictSchema>;

/** The 11 CanonicalStrategy rule-category keys — see CanonicalStrategySchema above. Exported so canonicalStrategy.ts's enrichment step can iterate them without re-listing them a third time. */
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
  conflicts: true,
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
    sourceLessonIds: { type: "array", items: { type: "number" } },
  },
  required: ["name", "purpose", "markets", "timeframes", "sections", "variants", "examples", "ambiguities", "conflicts", "sourceLessonIds"],
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

// ---- Stage 5: comprehensive playbook --------------------------------------

export const PlaybookSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
});

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
  coverageNote: z.string(),
});
export type FrameworkCoverage = z.infer<typeof FrameworkCoverageSchema>;

/** The final, persisted playbook document: Gemini's validated Playbook plus code-generated coverage metadata and sections (Coverage Notes, Source Index — see runSynthesis.ts). */
export interface CoursePlaybookDocument extends Playbook {
  frameworkCoverage: FrameworkCoverage;
}

// ---- Stage 6: master decision framework -----------------------------------

export const DecisionNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["start", "decision", "action", "end"]),
  label: z.string().min(1),
  description: nullableString(),
  next: z.array(z.string()),
  branches: z.array(z.object({ label: z.string(), next: z.string() })),
});

export const DecisionFrameworkSchema = z.object({
  nodes: z.array(DecisionNodeSchema),
  readableSteps: z.array(z.string()),
});
export type DecisionFramework = z.infer<typeof DecisionFrameworkSchema>;

export const DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA = {
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
        },
        required: ["id", "type", "label", "next", "branches"],
      },
    },
    readableSteps: { type: "array", items: { type: "string" } },
  },
  required: ["nodes", "readableSteps"],
};
