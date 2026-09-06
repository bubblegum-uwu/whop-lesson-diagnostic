import { describe, it, expect } from "vitest";
import {
  buildAnalysisSummary,
  ruleCounts,
  aggregateConfidence,
  extractedStrategiesLabel,
} from "../src/pipeline/analysisSummary.js";
import type { LessonStrategyAnalysis, Rule } from "../src/gemini/schema.js";

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    description: "desc",
    classification: "explicit",
    confidence: 0.8,
    start_timestamp: "00:01",
    end_timestamp: null,
    evidence: "evidence",
    ...overrides,
  };
}

function makeStrategy(name: string, overrides: Partial<LessonStrategyAnalysis["strategies"][number]> = {}) {
  return {
    strategy_name: name,
    market_or_instrument: [],
    timeframes: [],
    indicators: ["VWAP"],
    setup_conditions: [makeRule(), makeRule(), makeRule()],
    entry_rules: [makeRule({ confidence: 0.9, description: "retest entry" })],
    confirmation_rules: [],
    stop_loss_rules: [makeRule({ description: "market-structure stop" })],
    profit_target_rules: [makeRule({ description: "next-key-level targets" })],
    trade_management_rules: [],
    invalidation_rules: [makeRule(), makeRule()],
    no_trade_conditions: [],
    market_context_rules: [],
    visual_discretionary_rules: [],
    examples_shown: [],
    ambiguities: [],
    ...overrides,
  };
}

function noStrategyAnalysis(): LessonStrategyAnalysis {
  return { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [] };
}

describe("buildAnalysisSummary", () => {
  it('returns the fixed "no strategy" summary when strategy_found is false', () => {
    expect(buildAnalysisSummary(noStrategyAnalysis())).toBe("No concrete trading strategy taught.");
  });

  it("builds a deterministic template summary for one strategy (never calls Gemini)", () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: 100 },
      strategy_found: true,
      strategies: [makeStrategy("Break & Retest")],
    };
    const summary = buildAnalysisSummary(analysis);
    expect(summary).toContain("Break & Retest");
    expect(summary).toContain("retest entry");
    expect(summary).toContain("market-structure stop");
    expect(summary).toContain("next-key-level targets");
  });

  it("summarizes multiple strategies", () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: 100 },
      strategy_found: true,
      strategies: [makeStrategy("Break & Retest"), makeStrategy("VWAP Reclaim")],
    };
    const summary = buildAnalysisSummary(analysis);
    expect(summary).toContain("Break & Retest");
    expect(summary).toContain("VWAP Reclaim");
  });
});

describe("extractedStrategiesLabel", () => {
  it("returns null when no strategy was found", () => {
    expect(extractedStrategiesLabel(noStrategyAnalysis())).toBeNull();
  });

  it('returns the bare name for exactly one strategy', () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: null },
      strategy_found: true,
      strategies: [makeStrategy("Break & Retest")],
    };
    expect(extractedStrategiesLabel(analysis)).toBe("Break & Retest");
  });

  it('returns "Name +N more" for multiple strategies', () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: null },
      strategy_found: true,
      strategies: [makeStrategy("Break & Retest"), makeStrategy("A"), makeStrategy("B")],
    };
    expect(extractedStrategiesLabel(analysis)).toBe("Break & Retest +2 more");
  });
});

describe("ruleCounts", () => {
  it("counts rules per category across all strategies, omitting zero categories", () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: null },
      strategy_found: true,
      strategies: [makeStrategy("A")],
    };
    const counts = ruleCounts(analysis);
    expect(counts).toEqual([
      { label: "Setup", count: 3 },
      { label: "Entry", count: 1 },
      { label: "Stops", count: 1 },
      { label: "Targets", count: 1 },
      { label: "Invalidation", count: 2 },
    ]);
  });

  it("returns an empty array when there are no strategies", () => {
    expect(ruleCounts(noStrategyAnalysis())).toEqual([]);
  });
});

describe("aggregateConfidence", () => {
  it("returns null when there are no rules at all", () => {
    expect(aggregateConfidence(noStrategyAnalysis())).toBeNull();
  });

  it("averages confidence across every rule in every strategy (never a separate invented metric)", () => {
    const analysis: LessonStrategyAnalysis = {
      lesson: { title: "t", duration_seconds: null },
      strategy_found: true,
      strategies: [
        makeStrategy("A", {
          setup_conditions: [],
          entry_rules: [makeRule({ confidence: 1 })],
          stop_loss_rules: [],
          profit_target_rules: [],
          invalidation_rules: [makeRule({ confidence: 0 })],
        }),
      ],
    };
    expect(aggregateConfidence(analysis)).toBe(0.5);
  });
});
