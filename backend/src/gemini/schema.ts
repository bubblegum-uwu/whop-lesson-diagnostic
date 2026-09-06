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
 *
 * Pre-merge fidelity refinement (still v2 — see the version-number note
 * below): two real read-only diagnostic runs against production lessons
 * ("Sizing & Scaling Trades", "Support & Resistance, Key Levels & Market
 * Trends") confirmed the v2 shape above works, but exposed four places
 * where the extraction layer was still lossier than the eventual Phase
 * 3.5B synthesis will need:
 *
 *   1. `classification` (explicit/inferred/visual) existed on Strategy's
 *      `Rule` but not on `KnowledgeItem` — added, reusing the SAME
 *      `RuleClassification` enum, not a second one. Deliberately kept
 *      distinct from `ruleType`: classification is HOW a claim was
 *      obtained, ruleType is WHAT KIND of statement it is (its normative
 *      strength) — collapsing them would lose the "explicit HARD_RULE" vs
 *      "inferred HARD_RULE" distinction a future audit needs.
 *   2. Nothing recorded WHERE a rule applies, risking a scoped rule
 *      ("with one Apple contract I'd risk ~$150") reading downstream as a
 *      global one. Added `scope` (which strategies/instruments/timeframes/
 *      sessions/trader-profiles it's scoped to) as a required object on
 *      every KnowledgeItem.
 *   3. `conditions` (a single nullable string) conflated "when this rule
 *      applies" with "when the normally-applicable rule does NOT apply" —
 *      genuinely different things for a future rule engine. Added a
 *      separate `exceptions: string[]`, keeping `conditions` as-is.
 *   4. `NumericalValue` (`{value, unit, context}`) could not represent a
 *      comparison ("at least 2R"), a range ("1%-5%"), an approximation
 *      ("around 20%"), or distinguish a hard threshold from one number
 *      inside an instructor's dollar-amount example (which must never be
 *      promoted into a universal rule). Upgraded to carry an explicit
 *      `operator`/`value2`/`role`, plus `rawText` preserving the
 *      instructor's original wording verbatim and a `metric` naming what's
 *      being measured.
 *
 * None of this adds a new array-of-repeated-deep-shape dimension (the PR #9
 * failure mode this file's `knowledgeItems` collapse already guards
 * against) — `scope` is one more nested object per item, at the same
 * nesting depth `numericalValues` already sits at, not a new sibling array.
 *
 * Robustness fix (still v2): `scope` originally ALSO carried a Gemini-
 * generated `level: "GLOBAL"|"SCOPED"` field, redundant with the arrays and
 * enforced consistent with them via two `.refine()`s. The first real
 * diagnostic run against this refined schema ("Sizing & Scaling Trades")
 * failed Zod validation on exactly that redundancy: Gemini produced a
 * `level` that disagreed with its own arrays. `level` is now REMOVED from
 * what Gemini generates entirely — GLOBAL vs. SCOPED is derived
 * deterministically by application code from the arrays alone (see
 * `isKnowledgeItemScoped` below), so it can never again disagree with the
 * data it summarizes. This is the same principle this file already applies
 * to provenance (don't make Gemini reproduce/re-derive what the
 * application can compute itself), just applied to a second field.
 *
 * Version number: PROMPT_VERSION/SCHEMA_VERSION/EXTRACTOR_VERSION all stay
 * "v2" for this refinement (see analysisVersion.ts) rather than bumping to
 * "v3" — both real diagnostic runs that exercised the current v2 shape
 * were the READ-ONLY diagnostic script, which never persists
 * (`scripts/lessonAnalysisDiagnostic.ts` never calls createLessonAnalysis).
 * No "v2"-shaped row has ever actually been written to `lesson_analyses`;
 * the only real persisted rows are pre-Phase-3.5A "v1" ones. Bumping to
 * "v3" now would create a version distinction with nothing real on either
 * side of it. The version should bump the NEXT time this shape changes
 * after a real "v2" analysis has been persisted.
 *
 * Strategy-extraction regression fix (still v2, prompt-only): a real
 * diagnostic run against "Support & Resistance, Key Levels & Market
 * Trends" — which a pre-fidelity-refinement run of this same prompt
 * correctly extracted as strategy_found=true with a "Break and Retest"
 * strategy — came back strategy_found=false after the fidelity
 * refinement above, even though the model's own knowledgeItems/examples
 * still clearly recognized the Break & Retest setup (a DEFINITION item
 * with scope.strategies: ["Break & Retest"], four matching examples).
 * `STRATEGY_EXTRACTION_PROMPT`'s standalone-strategy paragraph (Task A)
 * was NOT itself edited by the fidelity refinement — it's byte-for-byte
 * identical to the pre-refinement version. The likely cause: Task B's
 * instructions grew substantially more detailed and emphatic (scope,
 * exceptions, numerical operator/role semantics), and nothing in the
 * prompt ever told the model the two tasks are independent — so a
 * setup the model recognized could get "absorbed" into the now much
 * more heavily-scaffolded Task B and never re-populate `strategies`.
 * Fixed by making that independence explicit and prominent (bookended
 * before Task A and again after Task B, not stated once and left to
 * compete with Task B's length), and by explicitly allowing a strategy
 * to qualify with some fields left discretionary/empty rather than
 * requiring a perfectly complete, machine-executable setup. No schema
 * change — Strategy/Rule/KnowledgeItem/NumericalValue/KnowledgeItemScope
 * are all byte-for-byte unchanged by this fix.
 *
 * Semantic precision pass (still v2, prompt-only): the two real
 * diagnostics that confirmed the regression fix above also surfaced
 * three narrower semantic issues in the SAME real output, none requiring
 * a schema change:
 *
 *   1. Scope/applicability contamination — `scope.marketsOrInstruments`
 *      and `Strategy.market_or_instrument` came back listing every
 *      ticker the instructor happened to demonstrate with (AAPL/AMD/
 *      AMZN/TSLA, AMD/NVDA), not genuine applicability restrictions.
 *      Strengthened both the scope paragraph and Task A's field
 *      description with an explicit test ("would the instructor imply
 *      this rule does NOT apply outside this value?") and a directive
 *      that demonstrated tickers belong in evidence/examples/
 *      examples_shown, never in an applicability array.
 *   2. BETWEEN vs. GTE — "two to three touches establish a level, and
 *      MORE touches make it stronger" came back as operator=BETWEEN,
 *      value2=3, wrongly implying 3 is a ceiling. Clarified that BETWEEN
 *      is only for a genuine two-sided bound (both numbers are real
 *      restrictions); an open-ended "at least N, more is fine/better"
 *      concept must be GTE with the true lower bound, never BETWEEN.
 *   3. Atomicity across applicability regimes — one item mixed general/
 *      beginner account-risk guidance with a materially different
 *      experienced-trader sizing approach inside a single item's
 *      `exceptions`. Strengthened the atomicity instruction to split on
 *      materially different trader-profile/instrument/strategy/session
 *      regimes into separate, individually-scoped items (preserving
 *      `conflictsAndAmbiguities` for a genuine conflict between them),
 *      while keeping `exceptions` reserved for a true carve-out under one
 *      parent rule's own applicability.
 *
 * No schema change for any of these — same reasoning as above: this is
 * about what VALUE the model puts into already-existing fields, not the
 * shape of those fields.
 */

/** Single source of truth for RuleClassification's values, reused by both Strategy's `Rule` and (v2 refinement) `KnowledgeItem` — HOW a claim was obtained, never conflated with `ruleType` (WHAT KIND of statement it is). */
const RULE_CLASSIFICATION_VALUES = ["explicit", "inferred", "visual"] as const;
export const RuleClassification = z.enum(RULE_CLASSIFICATION_VALUES);

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

/**
 * Where a KnowledgeItem applies. Every array empty means genuinely
 * course-wide/global — Gemini must actively narrow it, never the reverse.
 * Guards against exactly the failure mode the refinement was built for: an
 * instructor's one-contract dollar example reading downstream as a
 * universal account-management rule.
 *
 * There is deliberately NO `level: "GLOBAL"|"SCOPED"` field here. An
 * earlier version of this schema had one, generated by Gemini alongside
 * the arrays — a real diagnostic run against "Sizing & Scaling Trades"
 * showed Gemini can produce a `level` that disagrees with its own arrays
 * (e.g. `level: "GLOBAL"` with a non-empty array), which is exactly the
 * kind of redundant, Gemini-generated classification this codebase's own
 * lesson (see the top-of-file PR #11 note on not paying Gemini to
 * reproduce data the application already knows/can derive) says to avoid.
 * GLOBAL vs. SCOPED is now derived deterministically by application code
 * from the arrays alone — see `isKnowledgeItemScoped` below and
 * `pipeline/analysisSummary.ts`'s scoped/global counters — so it can never
 * disagree with the very data it summarizes.
 */
export const KnowledgeItemScopeSchema = z.object({
  /** Named strategy(ies) this rule is limited to, e.g. "Break & Retest" — empty if not strategy-specific. */
  strategies: z.array(z.string()),
  marketsOrInstruments: z.array(z.string()),
  timeframes: z.array(z.string()),
  /** e.g. "market-open", "premarket" — empty if not session-specific. */
  sessions: z.array(z.string()),
  /** e.g. "beginner", "experienced" — empty if not experience/profile-specific. */
  traderProfiles: z.array(z.string()),
});
export type KnowledgeItemScope = z.infer<typeof KnowledgeItemScopeSchema>;

/** True whenever ANY scope array is non-empty — SCOPED. All five empty means GLOBAL. The single source of truth for deriving this, reused by analysisSummary.ts and the frontend. */
export function isKnowledgeItemScoped(scope: KnowledgeItemScope): boolean {
  return scope.strategies.length > 0 || scope.marketsOrInstruments.length > 0 || scope.timeframes.length > 0 || scope.sessions.length > 0 || scope.traderProfiles.length > 0;
}

/**
 * category 16, "VERY IMPORTANT" per the spec — the semantic upgrade over a
 * bare {value, unit, context}: preserves comparison ("at least" -> GTE),
 * range ("1%-5%" -> BETWEEN with value2), approximation ("around 20%" ->
 * APPROX), and — critically — whether a number is a binding threshold, a
 * loose guideline, or just one figure inside an instructor's illustrative
 * example (which must never be promoted into a universal rule). Units are
 * preserved exactly as stated, never normalized/converted; `rawText`
 * preserves the instructor's original compact wording verbatim (e.g. "at
 * least 2R", "$20-$40") — never rewritten into cleaner prose.
 */
export const NumericalOperator = z.enum(["EQ", "GT", "GTE", "LT", "LTE", "BETWEEN", "APPROX"]);
export const NumericalRole = z.enum(["RULE_THRESHOLD", "GUIDELINE", "EXAMPLE", "REFERENCE", "DERIVED_EXAMPLE"]);
export const NumericalValueSchema = z
  .object({
    /** What's being measured, e.g. "account risk per trade", "reward-to-risk", "scale-out size" — not the unit, the quantity's name. */
    metric: z.string().min(1),
    operator: NumericalOperator,
    value: z.number(),
    /** Only set (non-null) when operator is BETWEEN — the range's upper bound. */
    value2: z.number().nullable(),
    unit: z.string().min(1),
    role: NumericalRole,
    /** The instructor's original compact wording, verbatim — e.g. "at least 2R", "1% to 5%", "around 20%". Never rewritten. */
    rawText: z.string().min(1),
    context: z.string().min(1),
  })
  .refine((v) => (v.operator === "BETWEEN") === (v.value2 != null), {
    message: "value2 must be set if and only if operator is BETWEEN",
    path: ["value2"],
  });
export type NumericalValue = z.infer<typeof NumericalValueSchema>;

export const KnowledgeItemSchema = z.object({
  category: KnowledgeCategory,
  statement: z.string().min(1),
  ruleType: RuleType,
  /** HOW this claim was obtained — distinct from ruleType (WHAT KIND of statement it is). Same enum/meaning as Strategy's Rule.classification. */
  classification: RuleClassification,
  confidence: z.number().min(0).max(1),
  /** The qualifying condition under which the statement applies ("normally X, when Y") — null when unconditional. Distinct from `exceptions` below: this is WHEN the rule applies, not when it doesn't. */
  conditions: z.string().nullable(),
  /** Cases where the normally-applicable rule should NOT be applied, or should be applied differently — semantically distinct from `conditions`. Empty array if none were stated. */
  exceptions: z.array(z.string()),
  scope: KnowledgeItemScopeSchema,
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
    classification: { type: "string", enum: [...RULE_CLASSIFICATION_VALUES] },
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

const knowledgeItemScopeJsonSchema = {
  type: "object",
  properties: {
    strategies: { type: "array", items: { type: "string" }, description: "Named strategy(ies) this rule is limited to, e.g. \"Break & Retest\" — empty if not strategy-specific." },
    marketsOrInstruments: { type: "array", items: { type: "string" }, description: "e.g. \"0-DTE options\", \"futures\", \"one specific ticker used only as an example\" — empty if not instrument-specific." },
    timeframes: { type: "array", items: { type: "string" } },
    sessions: { type: "array", items: { type: "string" }, description: "e.g. \"market-open\", \"premarket\" — empty if not session-specific." },
    traderProfiles: { type: "array", items: { type: "string" }, description: "e.g. \"beginner\", \"experienced\" — empty if not experience/profile-specific." },
  },
  required: ["strategies", "marketsOrInstruments", "timeframes", "sessions", "traderProfiles"],
};

const NUMERICAL_OPERATOR_VALUES = ["EQ", "GT", "GTE", "LT", "LTE", "BETWEEN", "APPROX"] as const;
const NUMERICAL_ROLE_VALUES = ["RULE_THRESHOLD", "GUIDELINE", "EXAMPLE", "REFERENCE", "DERIVED_EXAMPLE"] as const;

const numericalValueJsonSchema = {
  type: "object",
  properties: {
    metric: { type: "string", description: "What is being measured, e.g. \"account risk per trade\", \"reward-to-risk\", \"scale-out size\" — the quantity's name, not its unit." },
    operator: {
      type: "string",
      enum: [...NUMERICAL_OPERATOR_VALUES],
      description: "EQ=exactly, GT/GTE/LT/LTE=comparison (\"at least\"=GTE, \"no more than\"=LTE), BETWEEN=a range (set value2), APPROX=an approximation (\"around 20%\").",
    },
    value: { type: "number" },
    value2: { type: ["number", "null"], description: "Set ONLY when operator is BETWEEN — the range's upper bound. Null for every other operator." },
    unit: { type: "string", description: "Preserved exactly as stated — e.g. \"%\", \"R\", \"USD\", \"ticks\", \"points\", \"minutes\", \"months\", \"days\", \"candles\", \"contracts\", \"shares\", \"trades\". Never converted or normalized, and never forced into a narrower unit enum." },
    role: {
      type: "string",
      enum: [...NUMERICAL_ROLE_VALUES],
      description: "RULE_THRESHOLD=a binding rule threshold. GUIDELINE=a numerical recommendation. EXAMPLE=one figure inside an instructor's illustrative example. REFERENCE=a factual number that is not itself a trading rule. DERIVED_EXAMPLE=a number produced by arithmetic FROM an example (e.g. a dollar amount computed from an example account size) — never promote this into a universal rule.",
    },
    rawText: { type: "string", description: "The instructor's original compact wording, verbatim — e.g. \"at least 2R\", \"1% to 5%\", \"$20-$40\", \"around 20%\", \"at least 6 months\". Never rewritten into cleaner prose." },
    context: { type: "string" },
  },
  required: ["metric", "operator", "value", "value2", "unit", "role", "rawText", "context"],
};

const knowledgeItemJsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...KNOWLEDGE_CATEGORY_VALUES] },
    statement: { type: "string" },
    ruleType: { type: "string", enum: [...RULE_TYPE_VALUES] },
    classification: {
      type: "string",
      enum: [...RULE_CLASSIFICATION_VALUES],
      description: "HOW this claim was obtained — distinct from ruleType (WHAT KIND of statement it is). Same meaning as a Strategy rule's classification.",
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    conditions: {
      type: ["string", "null"],
      description: "The qualifying condition under which the statement applies (\"normally X, when Y\") — null if the statement is unconditional. Distinct from exceptions below: this is WHEN the rule applies, not when it doesn't.",
    },
    exceptions: {
      type: "array",
      items: { type: "string" },
      description: "Cases where the normally-applicable rule should NOT be applied, or should be applied differently — semantically distinct from conditions. Empty array if none were stated.",
    },
    scope: knowledgeItemScopeJsonSchema,
    numericalValues: { type: "array", items: numericalValueJsonSchema },
    start_timestamp: { type: "string", description: "MM:SS timestamp" },
    end_timestamp: { type: ["string", "null"], description: "MM:SS timestamp or null" },
    evidence: { type: "string" },
  },
  required: [
    "category",
    "statement",
    "ruleType",
    "classification",
    "confidence",
    "conditions",
    "exceptions",
    "scope",
    "numericalValues",
    "start_timestamp",
    "end_timestamp",
    "evidence",
  ],
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

This lesson may or may not teach a complete, standalone, executable trading strategy — many valuable lessons (risk management, position sizing, trade management, psychology, preparation routines) correctly do NOT, and that is expected, not a failure. You must perform TWO INDEPENDENT EXTRACTION TASKS (Task A, Task B), both fully, on every lesson:

*** TASK A AND TASK B ARE INDEPENDENT. THIS IS CRITICAL. ***
A trading rule, setup, or concept may legitimately — and should — appear BOTH as part of a structured Strategy (Task A) AND as one or more KnowledgeItems (Task B). That is NOT undesirable duplication; the two representations serve different downstream purposes (a structured, executable setup vs. maximum-fidelity source knowledge). Never reason "this is already represented in knowledgeItems, so I don't need to also populate strategies" — that is the single most common mistake to avoid. Populating knowledgeItems thoroughly is never a substitute for Task A, and vice versa. Do both, completely, independently.

TASK A — STANDALONE STRATEGY / SETUP EXTRACTION: if this video teaches one or more repeatable trading setups with meaningful execution logic (the instructor describes how to identify, enter, manage, and exit a trade — even if some details are left discretionary), extract them into "strategies": strategy_name, market_or_instrument, timeframes, indicators, setup_conditions, entry_rules, confirmation_rules, stop_loss_rules, profit_target_rules, trade_management_rules, invalidation_rules, no_trade_conditions, market_context_rules, visual_discretionary_rules, examples_shown, ambiguities. Set strategy_found to true and strategies to a non-empty array when such a setup is taught; otherwise set strategy_found to false and strategies to an empty array. strategy_found=false means ONLY "no repeatable setup with execution logic was taught here" — it does NOT mean the lesson has no useful content, and you must still fully populate "knowledge" below (Task B) regardless of strategy_found.

  A strategy DOES NOT need to be perfectly complete or machine-executable to qualify — do not reject an otherwise coherent setup just because one field remains discretionary or unspecified (e.g. the exact stop buffer, a precise target formula, an exact indicator threshold, or exact position size). Leave the corresponding rule array empty, or note the ambiguity in "ambiguities", rather than inventing a value or rejecting the whole strategy. Preserve as much strategy detail as the source actually provides across every field above — do not compress several distinct rules into one vague rule merely to save space, and do not invent missing information.

  Conversely, do NOT turn an isolated definition or general principle into a strategy on its own — a definition of support, a definition of resistance, general psychology, risk-management theory in the abstract, a definition of "break of structure" or "order block", or a generic market-structure discussion, taught in isolation, is knowledge (Task B), not a strategy. But when the instructor ASSEMBLES concepts like these into a repeatable setup with entry/execution logic (e.g. "resistance breaks and becomes support; wait for a retest of that new support with a bullish candle close, then enter, with a stop below the retest low and a target at the next resistance level") — that IS a strategy, and must be captured in "strategies" via Task A, even though the same concepts (the break-and-retest definition, the entry/stop/target rules, the examples shown) should ALSO be captured as KnowledgeItems and examples via Task B below.

  "market_or_instrument" and "timeframes" represent genuine APPLICABILITY RESTRICTIONS, not a list of every ticker or timeframe shown on screen. Ask: would the instructor imply this strategy does NOT work outside this value? If the setup is really "any liquid stock or option, on an intraday chart" and the instructor happened to demonstrate it on AMD and NVDA, market_or_instrument is ["equities", "options"] (or similarly general), NOT ["equities", "AMD", "NVDA", "futures"] — AMD/NVDA belong in "examples_shown", not in the applicability fields. Only list a specific instrument/timeframe when the instructor actually restricts the setup to it (e.g. "this only works on 0-DTE SPX options").

TASK B — LESSON KNOWLEDGE (always required, regardless of strategy_found): populate "knowledge" with every other piece of useful trading knowledge in this lesson, whether or not it is part of a standalone strategy:
   - summary: a concise description of what the lesson teaches, its major themes, and its primary learning objectives.
   - knowledgeItems: every individual claim, rule, or observation worth preserving — including content that would otherwise be lost when strategy_found is false, such as risk management, position sizing, scaling in/out, trade management, execution/order-flow mechanics, higher-timeframe analysis, pre-market preparation/routine, psychology/discipline, no-trade conditions, warnings/common mistakes, and definitions/terminology. Prefer MULTIPLE precise, atomic items over one broad summarized item when the lesson teaches materially different rules — never compress distinct entry/sizing/management/invalidation rules into one vague paragraph; keep concepts atomic enough that a later synthesis step can combine them without having already lost detail.

     SPLIT ON MATERIALLY DIFFERENT APPLICABILITY: when the instructor gives DIFFERENT normative guidance to different trader profiles, instruments, strategies, sessions, or market contexts, prefer separate, individually-scoped KnowledgeItems over one item with the differing regimes crammed into "conditions"/"exceptions". For example, if the instructor says beginners should risk 1-5% of account value while experienced traders sizing momentum options may size by contract count/dollar amount without tracking account percentage at all, that is TWO items (one scoped to traderProfiles: ["beginner"], one scoped to traderProfiles: ["experienced"]) — not one item with the experienced-trader behavior buried as an exception to the beginner rule. If the two regimes genuinely conflict or the boundary between them is unclear, also add an entry to "conflictsAndAmbiguities". Reserve "exceptions" for a TRUE exception to one parent rule (a specific carve-out under the same applicability), not for a fundamentally different rule that applies to a different population — do not over-split a single coherent rule that only has one real exception into multiple items, either.

     Tag each item with a "category" (market_context, risk_management, position_sizing, scaling_in, scaling_out, trade_management, execution, higher_timeframe, preparation, psychology, no_trade_conditions, warnings, or definitions) and a "ruleType" reflecting its ACTUAL strength exactly as stated — never conflate these:
       - HARD_RULE: an explicit, non-negotiable directive ("never risk more than 1% per trade", "always use a stop").
       - GUIDELINE: a recommended practice stated with some flexibility, not framed as an absolute.
       - PREFERENCE: the instructor's own personal habit, explicitly not universalized ("I usually...", "I like to...", "I look for...", "I avoid..." — never promote one of these into a HARD_RULE or GUIDELINE).
       - WARNING: a caution about risk or danger that is not itself a specific numeric rule.
       - PROHIBITION: an explicit "never/don't do this" instruction naming a forbidden action.
       - DEFINITION: a term or concept being explained.
       - OBSERVATION: a factual/descriptive statement about markets or behavior that is not itself a directive.

     Also tag each item with a "classification" — this is a DIFFERENT dimension from ruleType (ruleType is WHAT KIND of statement it is; classification is HOW you obtained it):
       - explicit: the instructor directly states or clearly teaches this.
       - inferred: you reasonably infer this from context, but it is not explicitly stated — never turn inferred, visual behavior into an "explicit" claim.
       - visual: materially derived from the chart/screen rather than verbal instruction alone.

     Every item needs a "scope" describing WHERE it applies — never broaden a rule beyond what the source actually supports. Default to { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] } (every array empty means genuinely course-wide/global) and populate one or more arrays with a non-empty value whenever the rule is meaningfully limited — to one strategy, one instrument type, one timeframe, one session, or one trader-experience level. Do NOT convert an example-specific rule into a universal course rule: if the instructor says "with one Apple contract I would risk around $150," that is scoped (marketsOrInstruments: ["Apple options contract example"]), never a global max-risk rule. Distinguish beginners vs. experienced traders, options vs. futures, options vs. equities, 0-DTE vs. swing, one specific example contract/ticker, one specific setup (e.g. PMH/PML only, ORB only, opening-drive only), one timeframe only, and session-specific guidance (market-open only, premarket only) whenever the lesson draws that distinction.

     CRITICAL — SCOPE ARRAYS REPRESENT APPLICABILITY, NOT EXAMPLES. A ticker, instrument, timeframe, session, or trader type does NOT belong in a scope array merely because it appears as an example on screen or in speech. Before adding a value to marketsOrInstruments/timeframes/sessions/traderProfiles, ask: "would the instructor imply this rule does NOT apply outside this value?" If no — if the rule is really general and the instructor just happened to illustrate it with AAPL, AMD, AMZN, and TSLA — the scope array must stay empty (or contain only the genuine restriction, e.g. ["options"]), and those ticker names belong in "evidence"/"examples"/"context"/"rawText" instead, never in a scope array. Only add a specific value when the rule is ACTUALLY restricted to it (e.g. a rule the instructor states applies only to 0-DTE options, or only to one named strategy).

     Capture "conditions" (the qualifying condition under which THIS statement applies, e.g. "when price gaps through the level" — null if unconditional) and, SEPARATELY, "exceptions" (a string array of cases where the normally-applicable rule should NOT be applied, or should be applied differently — e.g. "on an opening dip-and-rip, HOD may occur inside the entry candle, so standard HOD scaling may not apply the same way"). These are different things — a condition says when a rule applies; an exception says when it doesn't. Do not bury a meaningful exception inside a generic conditions string, and do not silently normalize an exception away. Empty array if none were stated.

     Capture EVERY meaningful numerical value mentioned for this item as "numericalValues" — do not return only one representative number if the instructor gives several. Each is: metric (what's measured, e.g. "account risk per trade"), operator, value, value2 (upper bound, ONLY when operator is BETWEEN, otherwise null), unit (preserved exactly as stated — %, R, USD, ticks, points, minutes, months, days, candles, contracts, shares, trades, etc. — never converted, never forced into a narrow unit set), role (RULE_THRESHOLD for a binding rule threshold; GUIDELINE for a numerical recommendation; EXAMPLE for one figure inside an instructor's illustrative example; REFERENCE for a factual number that is not itself a trading rule; DERIVED_EXAMPLE for a number produced by ARITHMETIC from an example, e.g. a dollar amount computed from a $25,000 example account — never promote a DERIVED_EXAMPLE or EXAMPLE into a universal RULE_THRESHOLD), rawText (the instructor's ORIGINAL compact wording verbatim, e.g. "at least 2R", "1% to 5%", "$20-$40", "around 20%", "at least 6 months", "two to three touches" — never rewritten into cleaner prose), and context.

     CHOOSING THE OPERATOR — this must reflect the LOGICAL meaning of what the instructor said, not just its surface phrasing: EQ for an exact figure. GT/GTE/LT/LTE for a stated one-sided comparison — "at least"/"minimum" is GTE, "no more than"/"max"/"maximum" is LTE. APPROX for an approximation ("around 20%"). BETWEEN is for a TRUE BOUNDED RANGE ONLY — use it only when BOTH numbers are actual restrictions the instructor means (e.g. "risk between 1% and 5%", "scale out 50% to 80%", "$20 to $40 risk" — going above or below either number would be against the guidance). Do NOT use BETWEEN merely because the instructor said two numbers near each other if the upper number is not really a ceiling — e.g. "two to three touches establish a level, and more touches make it stronger" is an OPEN-ENDED lower-bound concept (higher is fine, even better), so it must be GTE with value=2 (or the true minimum), value2=null — NEVER BETWEEN with value2=3, which would wrongly imply 3 is a cap. The same applies to "at least 2 or 3 confirmations" or "usually 2 to 3 but more is stronger." rawText still preserves the instructor's original wording ("two to three touches") even when the operator represents the true logical semantics (GTE), not the surface phrasing.

     Give each item a confidence score (0 to 1): how directly it was stated versus reasonably inferred — this is independent of, and must not be collapsed into, classification or ruleType.
   - examples: every concrete example or case study the instructor demonstrates on screen — the situation shown, which category it illustrates (or null if none fits), the outcome if one was shown, plus timestamp/evidence. Keep examples separate from knowledgeItems: an example is one specific instance, never a generalized rule. Do not manufacture a HARD_RULE knowledgeItem solely from an example unless the instructor explicitly presents it as a rule — but if the same concept genuinely appears BOTH as an explicit rule and as an example, it is fine to preserve both, since they serve different purposes.
   - conflictsAndAmbiguities: apparently conflicting statements, qualified rules, or unclear/context-dependent statements made WITHIN this one lesson. Do not silently reconcile contradictory guidance — preserve the source-level uncertainty faithfully; a later synthesis stage decides how to resolve it, not you.

For every individual rule/item/example, provide a start_timestamp (MM:SS), an end_timestamp (MM:SS or null if a single instant), and a short evidence explanation referencing what was said or shown. Never invent a rule, quantity, exception, or example that is not supported by the video. Preserve uncertainty, ambiguity, and strategy/timeframe/market/session/instrument/trader-experience-specific variation rather than generalizing it away — the goal of this extraction is MAXIMUM FIDELITY to what the source actually supports, not the shortest or prettiest output.

*** REMINDER: before responding, re-check Task A. *** If any KnowledgeItem above has a non-empty scope.strategies (i.e. you tagged content as belonging to a named strategy), re-confirm whether that same strategy also belongs in "strategies" via Task A — a named, repeatable setup with execution logic must be captured in BOTH places, never knowledge-only.

Respond ONLY with JSON matching the required schema.`;
