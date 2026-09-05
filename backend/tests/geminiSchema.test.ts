import { describe, it, expect } from "vitest";
import { LessonStrategyAnalysisSchema } from "../src/gemini/schema.js";

function baseRule(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    description: "Wait for a 5-minute close above the VWAP.",
    classification: "explicit",
    confidence: 0.9,
    start_timestamp: "04:12",
    end_timestamp: "04:30",
    evidence: "Instructor says 'wait for the candle to close above VWAP'.",
    ...overrides,
  };
}

function baseStrategy(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    strategy_name: "VWAP Reclaim",
    market_or_instrument: ["SPY"],
    timeframes: ["5m"],
    indicators: ["VWAP"],
    setup_conditions: [baseRule()],
    entry_rules: [baseRule()],
    confirmation_rules: [],
    stop_loss_rules: [baseRule({ description: "Stop below the prior low." })],
    profit_target_rules: [],
    trade_management_rules: [],
    invalidation_rules: [],
    no_trade_conditions: [],
    market_context_rules: [],
    visual_discretionary_rules: [],
    examples_shown: ["09:12 example on SPY 5m chart"],
    ambiguities: [],
    ...overrides,
  };
}

describe("LessonStrategyAnalysisSchema", () => {
  it("accepts a well-formed strategy_found:true payload", () => {
    const payload = {
      lesson: { title: "VWAP Reclaim Setup", duration_seconds: 1593 },
      strategy_found: true,
      strategies: [baseStrategy()],
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed strategy_found:false payload with an empty strategies array", () => {
    const payload = {
      lesson: { title: "Welcome to the course", duration_seconds: 240 },
      strategy_found: false,
      strategies: [],
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("rejects strategy_found:false with a non-empty strategies array (must not fabricate)", () => {
    const payload = {
      lesson: { title: "Intro", duration_seconds: 100 },
      strategy_found: false,
      strategies: [baseStrategy()],
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects strategy_found:true with an empty strategies array", () => {
    const payload = {
      lesson: { title: "Intro", duration_seconds: 100 },
      strategy_found: true,
      strategies: [],
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects a rule with an out-of-range confidence value", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: true,
      strategies: [baseStrategy({ entry_rules: [baseRule({ confidence: 1.5 })] })],
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a rule with an invalid classification value", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: true,
      strategies: [baseStrategy({ entry_rules: [baseRule({ classification: "guessed" })] })],
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a payload missing required top-level fields", () => {
    const payload = { strategy_found: true, strategies: [baseStrategy()] };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(false);
  });

  it("allows end_timestamp to be null for a single-instant rule", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: true,
      strategies: [baseStrategy({ entry_rules: [baseRule({ end_timestamp: null })] })],
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects completely malformed / non-object input", () => {
    expect(LessonStrategyAnalysisSchema.safeParse("not an object").success).toBe(false);
    expect(LessonStrategyAnalysisSchema.safeParse(null).success).toBe(false);
    expect(LessonStrategyAnalysisSchema.safeParse(undefined).success).toBe(false);
  });
});
