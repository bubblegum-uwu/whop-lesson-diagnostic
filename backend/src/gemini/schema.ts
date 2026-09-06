import { z } from "zod";

/**
 * Zod schema for the structured lesson-analysis result. This is the
 * runtime source of truth: Gemini's raw JSON output is parsed against this
 * schema before anything is returned to the client.
 *
 * `STRATEGY_RESPONSE_JSON_SCHEMA` below is a hand-kept JSON Schema mirror of
 * this same shape, passed to Gemini's `response_format.schema` so the model
 * is constrained to produce compatible output in the first place. Keep the
 * two in sync when editing either.
 *
 * v2 (Phase 3.5 — "rich trading knowledge extraction"): previously this
 * schema was gated entirely on "does this lesson teach a complete,
 * standalone trading setup?" — when it didn't (strategy_found=false), the
 * two Zod `.refine()`s below FORCED strategies=[] and effectively nothing
 * else was persisted (see pipeline/analysisSummary.ts's old hardcoded
 * "No concrete trading strategy taught." string). Real lessons like
 * "Sizing & Scaling Trades" or "Trade Management & Scaling" correctly have
 * no standalone setup while still teaching critical risk/sizing/management/
 * psychology content — that content had nowhere to go and was silently
 * discarded.
 *
 * v2 adds a `knowledge` object, ALWAYS populated regardless of
 * strategy_found, as a sibling of `strategies` (Option A from the Phase 3.5
 * scoping: the existing Strategy/Rule shapes are completely untouched —
 * `strategies` still means exactly what it always did, `strategy_found`
 * still means ONLY "a complete standalone setup was/wasn't taught," never
 * "this lesson has/hasn't useful content"). The two existing `.refine()`s
 * are unchanged.
 *
 * Wire-format lesson applied from PR #9/#11 (see synthesis/schema.ts's own
 * changelog for the full history): the 20 knowledge categories scoped for
 * this feature do NOT become 13+ separate sibling JSON Schema arrays of the
 * same nested shape — PR #9 confirmed that exact pattern (11 sibling arrays
 * of one nested rule shape) gets REJECTED with a real 400 by the Gemini
 * API. `knowledge.knowledgeItems` collapses them into ONE array tagged with
 * a `category` enum, mirroring canonical_strategy's `sections` collapse.
 *
 * PR #11's `sourceKeys` compaction (avoid making Gemini re-emit provenance
 * it was already shown) does NOT apply the same way here, and that's
 * deliberate, not an oversight: `sourceKeys` existed because canonical
 * strategy synthesis was RE-SYNTHESIZING from already-extracted per-rule
 * data Gemini had just been shown in its own prompt. Lesson analysis is
 * PRIMARY extraction directly from a video — there is no pre-existing
 * per-item data to key into; every `evidence`/timestamp here IS the
 * original claim being produced for the first time. What does carry over
 * from the existing RuleSchema (unchanged by this file): no rule/item ever
 * repeats lessonId/lessonTitle — that's attached once by the persisting
 * row's own context (see db/lessonAnalysesRepo.ts), never per-item.
 */

export const RuleClassification = z.enum(["explicit", "inferred", "visual"]);

export const RuleSchema = z.object({
  description: z.string().min(1),
  classification: RuleClassification,
  confidence: z.number().min(0).max(1),
  start_timestamp: z.string().min(1),
  end_timestamp: z.string().nullable(),
  evidence: z.string().min(1),
});
export type Rule = z.infer<typeof RuleSchema>;

export const StrategySchema = z.object({
  strategy_name: z.string().min(1),
  market_or_instrument: z.array(z.string()),
  timeframes: z.array(z.string()),
  indicators: z.array(z.string()),
  setup_conditions: z.array(RuleSchema),
  entry_rules: z.array(RuleSchema),
  confirmation_rules: z.array(RuleSchema),
  stop_loss_rules: z.array(RuleSchema),
  profit_target_rules: z.array(RuleSchema),
  trade_management_rules: z.array(RuleSchema),
  invalidation_rules: z.array(RuleSchema),
  no_trade_conditions: z.array(RuleSchema),
  market_context_rules: z.array(RuleSchema),
  visual_discretionary_rules: z.array(RuleSchema),
  examples_shown: z.array(z.string()),
  ambiguities: z.array(z.string()),
});
export type Strategy = z.infer<typeof StrategySchema>;

// ---- v2: rich lesson knowledge (Phase 3.5) --------------------------------

/**
 * The 13 non-strategy knowledge buckets this feature scopes (categories
 * 3-16 from the Phase 3.5 spec — category 1 "lesson summary" is
 * `LessonKnowledge.summary`, category 2 "strategies/setups" is the existing
 * `strategies` field, category 17 "examples" is `LessonKnowledge.examples`,
 * and category 20 "conflicts/ambiguity" is `LessonKnowledge.
 * conflictsAndAmbiguities`). Categories 18 (instructor heuristics) and 19
 * (exceptions) are deliberately NOT separate arrays — they're cross-cutting
 * dimensions of a single KnowledgeItem (ruleType=PREFERENCE, and
 * `conditions`, respectively), not distinct knowledge buckets, avoiding a
 * proliferation of near-duplicate top-level arrays.
 */
export const KnowledgeCategory = z.enum([
  "market_context",
  "risk_management",
  "position_sizing",
  "scaling_in",
  "scaling_out",
  "trade_management",
  "execution",
  "higher_timeframe",
  "preparation",
  "psychology",
  "no_trade_conditions",
  "warnings",
  "definitions",
]);
export type KnowledgeCategoryValue = z.infer<typeof KnowledgeCategory>;

/**
 * The deontic/epistemic STRENGTH of a knowledge item — deliberately
 * separate from `RuleClassification` above, which describes HOW something
 * was extracted (explicit/inferred/visual), not how binding it is. This is
 * the distinction the Phase 3.5 spec calls out explicitly: "never risk more
 * than 1%" (HARD_RULE) is not "I usually risk around 1%" (PREFERENCE) is
 * not "in this example I risked 1%" (which lives in `examples`, not as a
 * ruleType at all — an example is one instance, not a generalized rule).
 * A separate numeric `strength` field was considered and dropped: the
 * existing `confidence` (0-1, same convention as RuleSchema) already
 * serves that purpose — adding both would be a redundant, unmotivated
 * second axis.
 */
export const RuleType = z.enum([
  "HARD_RULE",
  "GUIDELINE",
  "PREFERENCE",
  "WARNING",
  "PROHIBITION",
  "DEFINITION",
  "OBSERVATION",
]);
export type RuleTypeValue = z.infer<typeof RuleType>;

/** An explicit quantity — category 16, "VERY IMPORTANT" per the spec. Units are preserved exactly as stated, never normalized/converted. */
export const NumericalValueSchema = z.object({
  value: z.number(),
  unit: z.string().min(1),
  context: z.string().min(1),
});
export type NumericalValue = z.infer<typeof NumericalValueSchema>;

export const KnowledgeItemSchema = z.object({
  category: KnowledgeCategory,
  statement: z.string().min(1),
  ruleType: RuleType,
  confidence: z.number().min(0).max(1),
  /** The qualifying exception ("normally X, except when Y") kept attached to its parent rule — null when the statement is unconditional. Never split into a separate, disconnected item. */
  conditions: z.string().nullable(),
  numericalValues: z.array(NumericalValueSchema),
  start_timestamp: z.string().min(1),
  end_timestamp: z.string().nullable(),
  evidence: z.string().min(1),
});
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;

/** Category 17 — a concrete example/case study, kept distinct from KnowledgeItem: an example is one specific instance, not a generalized rule. */
export const LessonExampleSchema = z.object({
  description: z.string().min(1),
  illustratesCategory: KnowledgeCategory.nullable(),
  outcome: z.string().nullable(),
  start_timestamp: z.string().min(1),
  end_timestamp: z.string().nullable(),
  evidence: z.string().min(1),
});
export type LessonExample = z.infer<typeof LessonExampleSchema>;

export const LessonKnowledgeSchema = z.object({
  /** Category 1: concise description, major themes, primary learning objectives. */
  summary: z.string(),
  /** Categories 3-16, collapsed into one category-tagged array — see this file's top comment for why. */
  knowledgeItems: z.array(KnowledgeItemSchema),
  /** Category 17. */
  examples: z.array(LessonExampleSchema),
  /** Category 20 — conflicts/ambiguity WITHIN this one lesson (cross-lesson conflicts are a synthesis-stage concern, not this file's). */
  conflictsAndAmbiguities: z.array(z.string()),
});
export type LessonKnowledge = z.infer<typeof LessonKnowledgeSchema>;

/**
 * Used ONLY to backfill a pre-v2 persisted analysis that predates this
 * field entirely (see db/lessonAnalysesRepo.ts's normalizeValidatedJson) —
 * never as a real Gemini response, and never persisted as-is for a NEW
 * analysis (a real v2 analysis always has Gemini's own `knowledge`, even
 * if every array within it happens to be empty).
 */
export const EMPTY_LESSON_KNOWLEDGE: LessonKnowledge = {
  summary: "",
  knowledgeItems: [],
  examples: [],
  conflictsAndAmbiguities: [],
};

export const LessonStrategyAnalysisSchema = z
  .object({
    lesson: z.object({
      title: z.string(),
      duration_seconds: z.number().nullable(),
    }),
    strategy_found: z.boolean(),
    strategies: z.array(StrategySchema),
    knowledge: LessonKnowledgeSchema,
  })
  .refine((data) => data.strategy_found || data.strategies.length === 0, {
    message: "strategies must be empty when strategy_found is false",
    path: ["strategies"],
  })
  .refine((data) => !data.strategy_found || data.strategies.length >= 1, {
    message: "strategies must contain at least one entry when strategy_found is true",
    path: ["strategies"],
  });

export type LessonStrategyAnalysis = z.infer<typeof LessonStrategyAnalysisSchema>;

/** JSON Schema mirror of the above, given to Gemini via response_format.schema. */
const ruleJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    classification: { type: "string", enum: ["explicit", "inferred", "visual"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    start_timestamp: { type: "string", description: "MM:SS timestamp" },
    end_timestamp: { type: ["string", "null"], description: "MM:SS timestamp or null" },
    evidence: { type: "string" },
  },
  required: [
    "description",
    "classification",
    "confidence",
    "start_timestamp",
    "end_timestamp",
    "evidence",
  ],
};

const ruleArray = { type: "array", items: ruleJsonSchema };

const strategyJsonSchema = {
  type: "object",
  properties: {
    strategy_name: { type: "string" },
    market_or_instrument: { type: "array", items: { type: "string" } },
    timeframes: { type: "array", items: { type: "string" } },
    indicators: { type: "array", items: { type: "string" } },
    setup_conditions: ruleArray,
    entry_rules: ruleArray,
    confirmation_rules: ruleArray,
    stop_loss_rules: ruleArray,
    profit_target_rules: ruleArray,
    trade_management_rules: ruleArray,
    invalidation_rules: ruleArray,
    no_trade_conditions: ruleArray,
    market_context_rules: ruleArray,
    visual_discretionary_rules: ruleArray,
    examples_shown: { type: "array", items: { type: "string" } },
    ambiguities: { type: "array", items: { type: "string" } },
  },
  required: [
    "strategy_name",
    "market_or_instrument",
    "timeframes",
    "indicators",
    "setup_conditions",
    "entry_rules",
    "confirmation_rules",
    "stop_loss_rules",
    "profit_target_rules",
    "trade_management_rules",
    "invalidation_rules",
    "no_trade_conditions",
    "market_context_rules",
    "visual_discretionary_rules",
    "examples_shown",
    "ambiguities",
  ],
};

/** Mirrors KnowledgeCategory above — kept as a single source-of-truth array so the Zod enum and every JSON-schema enum reference below stay in sync. */
const KNOWLEDGE_CATEGORY_VALUES = [
  "market_context",
  "risk_management",
  "position_sizing",
  "scaling_in",
  "scaling_out",
  "trade_management",
  "execution",
  "higher_timeframe",
  "preparation",
  "psychology",
  "no_trade_conditions",
  "warnings",
  "definitions",
] as const;

const RULE_TYPE_VALUES = ["HARD_RULE", "GUIDELINE", "PREFERENCE", "WARNING", "PROHIBITION", "DEFINITION", "OBSERVATION"] as const;

const numericalValueJsonSchema = {
  type: "object",
  properties: {
    value: { type: "number" },
    unit: { type: "string", description: "Preserved exactly as stated — e.g. \"%\", \"R\", \"ticks\", \"points\", \"minutes\", \"candles\", \"trades\". Never converted or normalized." },
    context: { type: "string" },
  },
  required: ["value", "unit", "context"],
};

const knowledgeItemJsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...KNOWLEDGE_CATEGORY_VALUES] },
    statement: { type: "string" },
    ruleType: { type: "string", enum: [...RULE_TYPE_VALUES] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    conditions: {
      type: ["string", "null"],
      description: "The qualifying exception, e.g. \"except when price gaps through the level\" — null if the statement is unconditional.",
    },
    numericalValues: { type: "array", items: numericalValueJsonSchema },
    start_timestamp: { type: "string", description: "MM:SS timestamp" },
    end_timestamp: { type: ["string", "null"], description: "MM:SS timestamp or null" },
    evidence: { type: "string" },
  },
  required: ["category", "statement", "ruleType", "confidence", "conditions", "numericalValues", "start_timestamp", "end_timestamp", "evidence"],
};

const lessonExampleJsonSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    illustratesCategory: { type: ["string", "null"], enum: [...KNOWLEDGE_CATEGORY_VALUES, null] },
    outcome: { type: ["string", "null"] },
    start_timestamp: { type: "string", description: "MM:SS timestamp" },
    end_timestamp: { type: ["string", "null"], description: "MM:SS timestamp or null" },
    evidence: { type: "string" },
  },
  required: ["description", "illustratesCategory", "outcome", "start_timestamp", "end_timestamp", "evidence"],
};

const lessonKnowledgeJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    knowledgeItems: { type: "array", items: knowledgeItemJsonSchema },
    examples: { type: "array", items: lessonExampleJsonSchema },
    conflictsAndAmbiguities: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "knowledgeItems", "examples", "conflictsAndAmbiguities"],
};

export const STRATEGY_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    lesson: {
      type: "object",
      properties: {
        title: { type: "string" },
        duration_seconds: { type: ["number", "null"] },
      },
      required: ["title", "duration_seconds"],
    },
    strategy_found: { type: "boolean" },
    strategies: { type: "array", items: strategyJsonSchema },
    knowledge: lessonKnowledgeJsonSchema,
  },
  required: ["lesson", "strategy_found", "strategies", "knowledge"],
};

export const STRATEGY_EXTRACTION_PROMPT = `You are analyzing one lesson video from a trading education course.

Analyze BOTH the spoken audio/instruction AND the visible on-screen trading charts and UI. This is knowledge reconstruction, not summarization.

This lesson may or may not teach a complete, standalone, executable trading strategy — many valuable lessons (risk management, position sizing, trade management, psychology, preparation routines) correctly do NOT, and that is expected, not a failure. Extract BOTH of the following, independently of each other:

1. STANDALONE STRATEGIES (only if actually taught): if — and only if — this video teaches one or more complete, executable trading setups, extract them into "strategies": strategy_name, market_or_instrument, timeframes, indicators, setup_conditions, entry_rules, confirmation_rules, stop_loss_rules, profit_target_rules, trade_management_rules, invalidation_rules, no_trade_conditions, market_context_rules, visual_discretionary_rules, examples_shown, ambiguities. Set strategy_found to true and strategies to a non-empty array ONLY when a complete setup is taught; otherwise set strategy_found to false and strategies to an empty array. strategy_found=false means ONLY "no complete standalone setup was taught here" — it does NOT mean the lesson has no useful content, and you must still fully populate "knowledge" below regardless of strategy_found.

2. LESSON KNOWLEDGE (always required, regardless of strategy_found): populate "knowledge" with every other piece of useful trading knowledge in this lesson, whether or not it is part of a standalone strategy:
   - summary: a concise description of what the lesson teaches, its major themes, and its primary learning objectives.
   - knowledgeItems: every individual claim, rule, or observation worth preserving — including content that would otherwise be lost when strategy_found is false, such as risk management, position sizing, scaling in/out, trade management, execution/order-flow mechanics, higher-timeframe analysis, pre-market preparation/routine, psychology/discipline, no-trade conditions, warnings/common mistakes, and definitions/terminology. Tag each item with a "category" (market_context, risk_management, position_sizing, scaling_in, scaling_out, trade_management, execution, higher_timeframe, preparation, psychology, no_trade_conditions, warnings, or definitions) and a "ruleType" reflecting its ACTUAL strength exactly as stated — never conflate these:
       - HARD_RULE: an explicit, non-negotiable directive ("never risk more than 1% per trade", "always use a stop").
       - GUIDELINE: a recommended practice stated with some flexibility, not framed as an absolute.
       - PREFERENCE: the instructor's own personal habit, explicitly not universalized ("I usually...", "I like to...", "I look for...", "I avoid..." — never promote one of these into a HARD_RULE or GUIDELINE).
       - WARNING: a caution about risk or danger that is not itself a specific numeric rule.
       - PROHIBITION: an explicit "never/don't do this" instruction naming a forbidden action.
       - DEFINITION: a term or concept being explained.
       - OBSERVATION: a factual/descriptive statement about markets or behavior that is not itself a directive.
     For every item also capture "conditions" (a qualifying exception stated for this specific rule, e.g. "except when price gaps through the level" — null if the rule is unconditional; keep the exception attached to its parent rule, never as a separate disconnected item) and "numericalValues" (every explicit quantity mentioned — percentages, R multiples, ticks/points, time windows, candle counts, stop distances, maximum trade counts, scale-out percentages — as {value, unit, context}, preserving each unit exactly as stated, never converted). Give each item a confidence score (0 to 1) using the same meaning as elsewhere: how directly it was stated versus reasonably inferred.
   - examples: every concrete example or case study the instructor demonstrates on screen — the situation shown, which category it illustrates (or null if none fits), the outcome if one was shown, plus timestamp/evidence. Keep examples separate from knowledgeItems: an example is one specific instance, never a generalized rule.
   - conflictsAndAmbiguities: apparently conflicting statements, qualified rules, or unclear/context-dependent statements made WITHIN this one lesson.

For every individual rule/item/example, provide a start_timestamp (MM:SS), an end_timestamp (MM:SS or null if a single instant), and a short evidence explanation referencing what was said or shown. Never invent a rule, quantity, or example that is not supported by the video.

Respond ONLY with JSON matching the required schema.`;
