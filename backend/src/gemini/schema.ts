import { z } from "zod";

/**
 * Zod schema for the structured strategy-extraction result. This is the
 * runtime source of truth: Gemini's raw JSON output is parsed against this
 * schema before anything is returned to the client.
 *
 * `STRATEGY_RESPONSE_JSON_SCHEMA` below is a hand-kept JSON Schema mirror of
 * this same shape, passed to Gemini's `response_format.schema` so the model
 * is constrained to produce compatible output in the first place. Keep the
 * two in sync when editing either.
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

export const LessonStrategyAnalysisSchema = z
  .object({
    lesson: z.object({
      title: z.string(),
      duration_seconds: z.number().nullable(),
    }),
    strategy_found: z.boolean(),
    strategies: z.array(StrategySchema),
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
  },
  required: ["lesson", "strategy_found", "strategies"],
};

export const STRATEGY_EXTRACTION_PROMPT = `You are analyzing one lesson video from a trading education course.

Analyze BOTH the spoken audio/instruction AND the visible on-screen trading charts and UI. This is strategy reconstruction, not summarization.

Extract a structured trading strategy (or strategies) actually taught in this video, covering: strategy_name, market_or_instrument, timeframes, indicators, setup_conditions, entry_rules, confirmation_rules, stop_loss_rules, profit_target_rules, trade_management_rules, invalidation_rules, no_trade_conditions, market_context_rules, visual_discretionary_rules, examples_shown, ambiguities.

For every individual rule, provide: description, classification ("explicit" if directly stated, "inferred" if reasonably implied but not stated outright, "visual" if it comes only from on-screen chart/UI content), a confidence score from 0 to 1, a start_timestamp (MM:SS), an end_timestamp (MM:SS or null if a single instant), and a short evidence explanation referencing what was said or shown.

Never invent a rule that is not supported by the video. If this lesson is introductory, promotional, or otherwise does not actually teach a concrete trading strategy, set strategy_found to false and return an empty strategies array rather than fabricating one.

Respond ONLY with JSON matching the required schema.`;
