import { describe, it, expect } from "vitest";
import {
  buildAnalysisSummary,
  ruleCounts,
  aggregateConfidence,
  extractedStrategiesLabel,
  knowledgeItemCounts,
  hasSupportingKnowledge,
  classificationCounts,
  scopedKnowledgeItemCount,
  globalKnowledgeItemCount,
  knowledgeItemsWithExceptionsCount,
  numericalValueCounts,
} from "../src/pipeline/analysisSummary.js";
import type { LessonStrategyAnalysis, Rule, KnowledgeItem, LessonKnowledge } from "../src/gemini/schema.js";

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

function makeKnowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    category: "risk_management",
    statement: "Never risk more than 1% of account equity on a single trade.",
    ruleType: "HARD_RULE",
    classification: "explicit",
    confidence: 0.95,
    conditions: null,
    exceptions: [],
    scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
    numericalValues: [
      { metric: "max risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "1%", context: "max risk per trade" },
    ],
    start_timestamp: "02:15",
    end_timestamp: null,
    evidence: "Spoken instruction at 02:15.",
    ...overrides,
  };
}

const emptyKnowledge: LessonKnowledge = { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] };

function noStrategyAnalysis(knowledge: LessonKnowledge = emptyKnowledge): LessonStrategyAnalysis {
  return { lesson: { title: "t", duration_seconds: null }, strategy_found: false, strategies: [], knowledge };
}

function strategyAnalysis(strategies: LessonStrategyAnalysis["strategies"], knowledge: LessonKnowledge = emptyKnowledge): LessonStrategyAnalysis {
  return { lesson: { title: "t", duration_seconds: 100 }, strategy_found: true, strategies, knowledge };
}

describe("buildAnalysisSummary", () => {
  it('returns the generic "nothing extracted" fallback only when BOTH strategy and knowledge are genuinely empty', () => {
    expect(buildAnalysisSummary(noStrategyAnalysis())).toBe("No concrete trading strategy or supporting knowledge extracted.");
  });

  it("returns the lesson's own knowledge.summary when strategy_found is false but supporting knowledge exists — never the old hardcoded string", () => {
    const knowledge: LessonKnowledge = {
      summary: "Covers risk management and position sizing for scaling into trades.",
      knowledgeItems: [makeKnowledgeItem()],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    const summary = buildAnalysisSummary(noStrategyAnalysis(knowledge));
    expect(summary).toBe("Covers risk management and position sizing for scaling into trades.");
    expect(summary).not.toBe("No concrete trading strategy taught.");
  });

  it("builds a deterministic template summary for one strategy (never calls Gemini)", () => {
    const analysis = strategyAnalysis([makeStrategy("Break & Retest")]);
    const summary = buildAnalysisSummary(analysis);
    expect(summary).toContain("Break & Retest");
    expect(summary).toContain("retest entry");
    expect(summary).toContain("market-structure stop");
    expect(summary).toContain("next-key-level targets");
  });

  it("summarizes multiple strategies", () => {
    const analysis = strategyAnalysis([makeStrategy("Break & Retest"), makeStrategy("VWAP Reclaim")]);
    const summary = buildAnalysisSummary(analysis);
    expect(summary).toContain("Break & Retest");
    expect(summary).toContain("VWAP Reclaim");
  });

  it("prefers the strategy summary over knowledge.summary when both are present — the strategy synopsis is more specific", () => {
    const knowledge: LessonKnowledge = { summary: "General lesson themes.", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] };
    const summary = buildAnalysisSummary(strategyAnalysis([makeStrategy("Break & Retest")], knowledge));
    expect(summary).toContain("Break & Retest");
    expect(summary).not.toContain("General lesson themes.");
  });
});

describe("extractedStrategiesLabel", () => {
  it("returns null when no strategy was found", () => {
    expect(extractedStrategiesLabel(noStrategyAnalysis())).toBeNull();
  });

  it('returns the bare name for exactly one strategy', () => {
    const analysis = strategyAnalysis([makeStrategy("Break & Retest")]);
    expect(extractedStrategiesLabel(analysis)).toBe("Break & Retest");
  });

  it('returns "Name +N more" for multiple strategies', () => {
    const analysis = strategyAnalysis([makeStrategy("Break & Retest"), makeStrategy("A"), makeStrategy("B")]);
    expect(extractedStrategiesLabel(analysis)).toBe("Break & Retest +2 more");
  });
});

describe("ruleCounts", () => {
  it("counts rules per category across all strategies, omitting zero categories", () => {
    const analysis = strategyAnalysis([makeStrategy("A")]);
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
    const analysis = strategyAnalysis([
      makeStrategy("A", {
        setup_conditions: [],
        entry_rules: [makeRule({ confidence: 1 })],
        stop_loss_rules: [],
        profit_target_rules: [],
        invalidation_rules: [makeRule({ confidence: 0 })],
      }),
    ]);
    expect(aggregateConfidence(analysis)).toBe(0.5);
  });
});

describe("knowledgeItemCounts", () => {
  it("counts knowledgeItems per category, omitting zero categories, in a stable order", () => {
    const knowledge: LessonKnowledge = {
      summary: "s",
      knowledgeItems: [
        makeKnowledgeItem({ category: "risk_management" }),
        makeKnowledgeItem({ category: "risk_management" }),
        makeKnowledgeItem({ category: "psychology", ruleType: "PREFERENCE" }),
      ],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(knowledgeItemCounts(noStrategyAnalysis(knowledge))).toEqual([
      { label: "Risk Management", count: 2 },
      { label: "Psychology", count: 1 },
    ]);
  });

  it("returns an empty array when there are no knowledge items", () => {
    expect(knowledgeItemCounts(noStrategyAnalysis())).toEqual([]);
  });
});

describe("hasSupportingKnowledge", () => {
  it("is false when knowledge is entirely empty", () => {
    expect(hasSupportingKnowledge(noStrategyAnalysis())).toBe(false);
  });

  it("is true when knowledgeItems has at least one item, even with no strategy", () => {
    const knowledge: LessonKnowledge = { summary: "", knowledgeItems: [makeKnowledgeItem()], examples: [], conflictsAndAmbiguities: [] };
    expect(hasSupportingKnowledge(noStrategyAnalysis(knowledge))).toBe(true);
  });

  it("is true when only examples or conflictsAndAmbiguities or summary are present, even with zero knowledgeItems", () => {
    expect(hasSupportingKnowledge(noStrategyAnalysis({ summary: "s", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] }))).toBe(true);
    expect(
      hasSupportingKnowledge(
        noStrategyAnalysis({
          summary: "",
          knowledgeItems: [],
          examples: [{ description: "d", illustratesCategory: null, outcome: null, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
          conflictsAndAmbiguities: [],
        }),
      ),
    ).toBe(true);
    expect(hasSupportingKnowledge(noStrategyAnalysis({ summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: ["c"] }))).toBe(true);
  });
});

describe("classificationCounts", () => {
  it("counts explicit/inferred/visual across all knowledgeItems", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [
        makeKnowledgeItem({ classification: "explicit" }),
        makeKnowledgeItem({ classification: "explicit" }),
        makeKnowledgeItem({ classification: "inferred" }),
        makeKnowledgeItem({ classification: "visual" }),
      ],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(classificationCounts(noStrategyAnalysis(knowledge))).toEqual({ explicit: 2, inferred: 1, visual: 1 });
  });

  it("returns all zeros when there are no knowledge items", () => {
    expect(classificationCounts(noStrategyAnalysis())).toEqual({ explicit: 0, inferred: 0, visual: 0 });
  });
});

// Robustness fix: GLOBAL/SCOPED is no longer a Gemini-generated `level`
// field (a real diagnostic run showed Gemini could produce one that
// disagreed with its own arrays) — it's derived deterministically from the
// five scope arrays alone. These tests cover every array individually plus
// the multi-array case (test requirement #7).
const emptyScope = { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] };

describe("scopedKnowledgeItemCount / globalKnowledgeItemCount — derived from scope arrays, never a generated field", () => {
  it("derives GLOBAL when all five scope arrays are empty", () => {
    const knowledge: LessonKnowledge = { summary: "", knowledgeItems: [makeKnowledgeItem({ scope: emptyScope })], examples: [], conflictsAndAmbiguities: [] };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(0);
    expect(globalKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });

  it("derives SCOPED when strategies is populated", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: { ...emptyScope, strategies: ["Break & Retest"] } })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
    expect(globalKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(0);
  });

  it("derives SCOPED when marketsOrInstruments is populated (e.g. the one-contract dollar example)", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: { ...emptyScope, marketsOrInstruments: ["Apple options contract example"] } })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });

  it("derives SCOPED when timeframes is populated", () => {
    const knowledge: LessonKnowledge = { summary: "", knowledgeItems: [makeKnowledgeItem({ scope: { ...emptyScope, timeframes: ["5m"] } })], examples: [], conflictsAndAmbiguities: [] };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });

  it("derives SCOPED when sessions is populated", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: { ...emptyScope, sessions: ["market-open"] } })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });

  it("derives SCOPED when traderProfiles is populated", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: { ...emptyScope, traderProfiles: ["beginner"] } })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });

  it("derives SCOPED when multiple arrays are populated at once — still counted exactly once, not double-counted", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: { strategies: ["Break & Retest"], marketsOrInstruments: ["ES"], timeframes: ["5m"], sessions: [], traderProfiles: [] } })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
    expect(globalKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(0);
  });

  it("counts a mix of scoped and global items correctly, never double-counting either", () => {
    const scopedToOneContract = { ...emptyScope, marketsOrInstruments: ["Apple options contract example"] };
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [makeKnowledgeItem({ scope: scopedToOneContract }), makeKnowledgeItem({ scope: emptyScope }), makeKnowledgeItem({ scope: scopedToOneContract })],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(scopedKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(2);
    expect(globalKnowledgeItemCount(noStrategyAnalysis(knowledge))).toBe(1);
  });
});

describe("knowledgeItemsWithExceptionsCount", () => {
  it("counts items with at least one exception, ignoring items with none", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [
        makeKnowledgeItem({ exceptions: ["on an opening dip-and-rip, HOD may occur inside the entry candle"] }),
        makeKnowledgeItem({ exceptions: [] }),
      ],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(knowledgeItemsWithExceptionsCount(noStrategyAnalysis(knowledge))).toBe(1);
  });
});

describe("numericalValueCounts", () => {
  it("breaks down every numericalValue across every knowledgeItem by role", () => {
    const knowledge: LessonKnowledge = {
      summary: "",
      knowledgeItems: [
        makeKnowledgeItem({
          numericalValues: [
            { metric: "reward-to-risk", operator: "GTE", value: 2, value2: null, unit: "R", role: "RULE_THRESHOLD", rawText: "at least 2R", context: "average outcome" },
            { metric: "scale-out size", operator: "BETWEEN", value: 50, value2: 80, unit: "%", role: "GUIDELINE", rawText: "50%-80%", context: "scale out" },
          ],
        }),
        makeKnowledgeItem({
          numericalValues: [
            { metric: "account risk", operator: "APPROX", value: 150, value2: null, unit: "USD", role: "EXAMPLE", rawText: "around $150", context: "one Apple contract example" },
            { metric: "position size", operator: "EQ", value: 2500, value2: null, unit: "USD", role: "DERIVED_EXAMPLE", rawText: "$2,500", context: "10% of a $25,000 example account" },
          ],
        }),
      ],
      examples: [],
      conflictsAndAmbiguities: [],
    };
    expect(numericalValueCounts(noStrategyAnalysis(knowledge))).toEqual({
      total: 4,
      ruleThreshold: 1,
      guideline: 1,
      example: 1,
      reference: 0,
      derivedExample: 1,
    });
  });

  it("is all zero when there are no numericalValues at all", () => {
    expect(numericalValueCounts(noStrategyAnalysis())).toEqual({ total: 0, ruleThreshold: 0, guideline: 0, example: 0, reference: 0, derivedExample: 0 });
  });
});
