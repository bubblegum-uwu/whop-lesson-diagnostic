import { describe, it, expect } from "vitest";
import {
  LessonStrategyAnalysisSchema,
  KnowledgeItemSchema,
  LessonKnowledgeSchema,
  LessonExampleSchema,
  STRATEGY_RESPONSE_JSON_SCHEMA,
  STRATEGY_EXTRACTION_PROMPT,
} from "../src/gemini/schema.js";

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

function baseNumericalValue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    metric: "max risk per trade",
    operator: "LTE",
    value: 1,
    value2: null,
    unit: "%",
    role: "RULE_THRESHOLD",
    rawText: "1%",
    context: "max risk per trade",
    ...overrides,
  };
}

function baseScope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    strategies: [],
    marketsOrInstruments: [],
    timeframes: [],
    sessions: [],
    traderProfiles: [],
    ...overrides,
  };
}

function baseKnowledgeItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    category: "risk_management",
    statement: "Never risk more than 1% of account equity on a single trade.",
    ruleType: "HARD_RULE",
    classification: "explicit",
    confidence: 0.95,
    conditions: null,
    exceptions: [],
    scope: baseScope(),
    numericalValues: [baseNumericalValue()],
    start_timestamp: "02:15",
    end_timestamp: null,
    evidence: "Spoken instruction at 02:15.",
    ...overrides,
  };
}

function baseExample(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    description: "A trade sized at 1% risk on a $10,000 account.",
    illustratesCategory: "position_sizing",
    outcome: "Stopped out for the planned 1% loss.",
    start_timestamp: "05:00",
    end_timestamp: "05:45",
    evidence: "\"Here I risked exactly 1%.\"",
    ...overrides,
  };
}

function emptyKnowledge(overrides: Partial<Record<string, unknown>> = {}) {
  return { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [], ...overrides };
}

describe("LessonStrategyAnalysisSchema", () => {
  it("accepts a well-formed strategy_found:true payload", () => {
    const payload = {
      lesson: { title: "VWAP Reclaim Setup", duration_seconds: 1593 },
      strategy_found: true,
      strategies: [baseStrategy()],
      knowledge: emptyKnowledge(),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed strategy_found:false payload with an empty strategies array", () => {
    const payload = {
      lesson: { title: "Welcome to the course", duration_seconds: 240 },
      strategy_found: false,
      strategies: [],
      knowledge: emptyKnowledge(),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  // Phase 3.5: the entire reason this feature exists — strategy_found:false
  // must be able to carry real, non-empty `knowledge` (test scenario #15).
  it("accepts strategy_found:false with a NON-EMPTY knowledge — this is the exact case the rich extractor exists for", () => {
    const payload = {
      lesson: { title: "Trade Management & Scaling", duration_seconds: 3840 },
      strategy_found: false,
      strategies: [],
      knowledge: emptyKnowledge({
        summary: "Covers risk management and position sizing for scaling into trades.",
        knowledgeItems: [baseKnowledgeItem()],
        examples: [baseExample()],
        conflictsAndAmbiguities: ["Unclear whether the 1% figure is per-trade or per-day."],
      }),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strategy_found).toBe(false);
      expect(result.data.knowledge.knowledgeItems).toHaveLength(1);
    }
  });

  it("rejects a payload missing knowledge entirely (v1 shape is no longer accepted from Gemini directly)", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: false,
      strategies: [],
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects strategy_found:false with a non-empty strategies array (must not fabricate)", () => {
    const payload = {
      lesson: { title: "Intro", duration_seconds: 100 },
      strategy_found: false,
      strategies: [baseStrategy()],
      knowledge: emptyKnowledge(),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects strategy_found:true with an empty strategies array", () => {
    const payload = {
      lesson: { title: "Intro", duration_seconds: 100 },
      strategy_found: true,
      strategies: [],
      knowledge: emptyKnowledge(),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects a rule with an out-of-range confidence value", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: true,
      strategies: [baseStrategy({ entry_rules: [baseRule({ confidence: 1.5 })] })],
      knowledge: emptyKnowledge(),
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a rule with an invalid classification value", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: true,
      strategies: [baseStrategy({ entry_rules: [baseRule({ classification: "guessed" })] })],
      knowledge: emptyKnowledge(),
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
      knowledge: emptyKnowledge(),
    };
    expect(LessonStrategyAnalysisSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects completely malformed / non-object input", () => {
    expect(LessonStrategyAnalysisSchema.safeParse("not an object").success).toBe(false);
    expect(LessonStrategyAnalysisSchema.safeParse(null).success).toBe(false);
    expect(LessonStrategyAnalysisSchema.safeParse(undefined).success).toBe(false);
  });
});

describe("KnowledgeItemSchema — the normalized rich-knowledge rule shape", () => {
  it("accepts a well-formed HARD_RULE item with numericalValues and no conditions", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem()).success).toBe(true);
  });

  it.each(["market_context", "risk_management", "position_sizing", "scaling_in", "scaling_out", "trade_management", "execution", "higher_timeframe", "preparation", "psychology", "no_trade_conditions", "warnings", "definitions"])(
    "accepts category %s",
    (category) => {
      expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ category })).success).toBe(true);
    },
  );

  it("rejects an unknown category", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ category: "not_a_real_category" })).success).toBe(false);
  });

  // The hard-rule-vs-preference distinction is load-bearing: these are all
  // valid ruleType VALUES, but distinct semantic strengths — never collapsed.
  it.each(["HARD_RULE", "GUIDELINE", "PREFERENCE", "WARNING", "PROHIBITION", "DEFINITION", "OBSERVATION"])(
    "accepts ruleType %s",
    (ruleType) => {
      expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ ruleType })).success).toBe(true);
    },
  );

  it("rejects an unknown ruleType — never silently accepted as some default strength", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ ruleType: "SUGGESTION" })).success).toBe(false);
  });

  it("distinguishes a HARD_RULE from a PREFERENCE for the same category — 'never risk more than 1%' vs 'I usually risk around 1%' are not the same semantic strength", () => {
    const hardRule = KnowledgeItemSchema.parse(baseKnowledgeItem({ statement: "Never risk more than 1% of account equity.", ruleType: "HARD_RULE" }));
    const preference = KnowledgeItemSchema.parse(baseKnowledgeItem({ statement: "I usually risk around 1%.", ruleType: "PREFERENCE" }));
    expect(hardRule.ruleType).not.toBe(preference.ruleType);
  });

  it("keeps a conditional exception attached to its own item via `conditions`, not as a separate disconnected item", () => {
    const withCondition = KnowledgeItemSchema.parse(
      baseKnowledgeItem({ statement: "Wait for candle confirmation before entering.", conditions: "Except when price gaps through the level." }),
    );
    expect(withCondition.conditions).toBe("Except when price gaps through the level.");
  });

  it("allows conditions to be null when the rule is unconditional", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ conditions: null })).success).toBe(true);
  });

  it("preserves numericalValues' units exactly, without any implied conversion", () => {
    const values = [
      baseNumericalValue({ metric: "minimum reward-to-risk", operator: "GTE", value: 2, unit: "R", rawText: "at least 2R", context: "minimum reward-to-risk" }),
      baseNumericalValue({ metric: "confirmation window", operator: "EQ", value: 3, unit: "candles", rawText: "3 candles", context: "confirmation window" }),
    ];
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ numericalValues: values }));
    expect(parsed.numericalValues).toEqual(values);
  });

  it("allows an item with zero numericalValues — not every rule has an explicit quantity", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [] })).success).toBe(true);
  });

  it("rejects a confidence value out of the 0-1 range", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ confidence: 1.2 })).success).toBe(false);
  });
});

// Pre-merge fidelity refinement, item A: classification (HOW a claim was
// obtained) is a REQUIRED, DIFFERENT dimension from ruleType (WHAT KIND of
// statement it is) — same enum/meaning as Strategy's Rule.classification.
describe("KnowledgeItemSchema — classification (distinct from ruleType)", () => {
  it.each(["explicit", "inferred", "visual"])("accepts classification %s", (classification) => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ classification })).success).toBe(true);
  });

  it("rejects an unknown classification", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ classification: "guessed" })).success).toBe(false);
  });

  it("rejects a payload missing classification entirely", () => {
    const { classification: _omit, ...withoutClassification } = baseKnowledgeItem();
    expect(KnowledgeItemSchema.safeParse(withoutClassification).success).toBe(false);
  });

  it("keeps classification and ruleType as independent axes — an explicit HARD_RULE and an inferred HARD_RULE both validate, distinctly", () => {
    const explicitHardRule = KnowledgeItemSchema.parse(baseKnowledgeItem({ ruleType: "HARD_RULE", classification: "explicit" }));
    const inferredHardRule = KnowledgeItemSchema.parse(baseKnowledgeItem({ ruleType: "HARD_RULE", classification: "inferred" }));
    expect(explicitHardRule.ruleType).toBe(inferredHardRule.ruleType);
    expect(explicitHardRule.classification).not.toBe(inferredHardRule.classification);
  });
});

// Pre-merge fidelity refinement, item B: structured scope — guards against
// an example-specific rule ("with one Apple contract I'd risk ~$150")
// reading downstream as a universal one.
//
// Robustness fix: `scope` no longer carries a Gemini-generated
// `level: "GLOBAL"|"SCOPED"` field — a real diagnostic run showed Gemini
// can produce one that disagrees with its own arrays. GLOBAL/SCOPED is now
// PURELY DERIVED from the arrays by application code (isKnowledgeItemScoped,
// tested in analysisSummary.test.ts's scopedKnowledgeItemCount/
// globalKnowledgeItemCount tests), so there is no longer a `level` value
// for this schema layer to validate consistency against — any combination
// of empty/non-empty arrays is a structurally valid `scope`.
describe("KnowledgeItemSchema — scope arrays (GLOBAL vs SCOPED is derived, never Gemini-generated)", () => {
  it("accepts a scope with every array empty (derived GLOBAL)", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ scope: baseScope() })).success).toBe(true);
  });

  it("accepts a scope narrowed to one strategy (derived SCOPED)", () => {
    const scope = baseScope({ strategies: ["Break & Retest"] });
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ scope }));
    expect(parsed.scope).toEqual(scope);
  });

  it("accepts a scope narrowed to one instrument type (e.g. 0-DTE options vs. swing)", () => {
    const scope = baseScope({ marketsOrInstruments: ["0-DTE options"] });
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ scope })).success).toBe(true);
  });

  it("accepts a scope narrowed to one timeframe or session", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ scope: baseScope({ timeframes: ["5m"] }) })).success).toBe(true);
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ scope: baseScope({ sessions: ["market-open"] }) })).success).toBe(true);
  });

  it("accepts a scope narrowed to a trader profile (e.g. beginner vs. experienced)", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ scope: baseScope({ traderProfiles: ["beginner"] }) })).success).toBe(true);
  });

  it("never asks Gemini to generate a level field — the wire schema's scope properties are exactly the five arrays, nothing else", () => {
    const scopeProps = Object.keys(
      (
        (STRATEGY_RESPONSE_JSON_SCHEMA.properties.knowledge.properties.knowledgeItems.items as { properties: { scope: { properties: object } } }).properties.scope as { properties: object }
      ).properties,
    );
    expect(scopeProps.sort()).toEqual(["marketsOrInstruments", "sessions", "strategies", "timeframes", "traderProfiles"].sort());
    expect(scopeProps).not.toContain("level");
  });

  it("keeps an example-specific rule's scope arrays populated, never silently cleared — the one-contract dollar example stays narrowed", () => {
    const scoped = KnowledgeItemSchema.parse(
      baseKnowledgeItem({
        statement: "With one Apple contract I would risk around $150.",
        ruleType: "OBSERVATION",
        scope: baseScope({ marketsOrInstruments: ["Apple options contract example"] }),
      }),
    );
    expect(scoped.scope.marketsOrInstruments).toEqual(["Apple options contract example"]);
  });
});

// Pre-merge fidelity refinement, item C: NumericalValue upgraded from a bare
// {value, unit, context} to carry comparison/range/approximation semantics
// and a role distinguishing a binding threshold from an illustrative example.
describe("NumericalValueSchema (via KnowledgeItemSchema) — operator/value2/role semantics", () => {
  it.each(["EQ", "GT", "GTE", "LT", "LTE", "APPROX"])("accepts operator %s with value2 null", (operator) => {
    const value = baseNumericalValue({ operator, value2: null });
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [value] })).success).toBe(true);
  });

  it("accepts operator BETWEEN with value2 set — '1% to 5%' is a real range, not one bare number", () => {
    const value = baseNumericalValue({ metric: "account risk", operator: "BETWEEN", value: 1, value2: 5, unit: "%", role: "GUIDELINE", rawText: "1% to 5%", context: "account risk guidance" });
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ numericalValues: [value] }));
    expect(parsed.numericalValues[0]).toEqual(value);
  });

  it("rejects operator BETWEEN with value2 null — a range must carry its upper bound", () => {
    const value = baseNumericalValue({ operator: "BETWEEN", value2: null });
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [value] })).success).toBe(false);
  });

  it("rejects a non-BETWEEN operator that still sets value2 — value2 must be set if and only if operator is BETWEEN", () => {
    const value = baseNumericalValue({ operator: "GTE", value2: 5 });
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [value] })).success).toBe(false);
  });

  it.each(["RULE_THRESHOLD", "GUIDELINE", "EXAMPLE", "REFERENCE", "DERIVED_EXAMPLE"])("accepts role %s", (role) => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [baseNumericalValue({ role })] })).success).toBe(true);
  });

  it("rejects an unknown operator or role", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [baseNumericalValue({ operator: "MAYBE" })] })).success).toBe(false);
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ numericalValues: [baseNumericalValue({ role: "MAYBE" })] })).success).toBe(false);
  });

  it("distinguishes a RULE_THRESHOLD from an EXAMPLE/DERIVED_EXAMPLE for the same account-size arithmetic — a derived example must never be promoted into a universal rule", () => {
    const ruleThreshold = KnowledgeItemSchema.parse(
      baseKnowledgeItem({ numericalValues: [baseNumericalValue({ metric: "account risk", role: "RULE_THRESHOLD", operator: "LTE", value: 1, unit: "%", rawText: "no more than 1%" })] }),
    );
    const derivedExample = KnowledgeItemSchema.parse(
      baseKnowledgeItem({
        numericalValues: [baseNumericalValue({ metric: "position size", role: "DERIVED_EXAMPLE", operator: "EQ", value: 2500, unit: "USD", rawText: "$2,500", context: "10% of a $25,000 example account" })],
      }),
    );
    expect(ruleThreshold.numericalValues[0]?.role).toBe("RULE_THRESHOLD");
    expect(derivedExample.numericalValues[0]?.role).toBe("DERIVED_EXAMPLE");
    expect(ruleThreshold.numericalValues[0]?.role).not.toBe(derivedExample.numericalValues[0]?.role);
  });

  it("preserves the instructor's original wording verbatim in rawText — never rewritten into cleaner prose", () => {
    const value = baseNumericalValue({ rawText: "at least 6 months" });
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ numericalValues: [value] }));
    expect(parsed.numericalValues[0]?.rawText).toBe("at least 6 months");
  });

  it("captures multiple distinct numericalValues on one item — never collapsed to a single representative figure", () => {
    const values = [
      baseNumericalValue({ metric: "daily drawdown", role: "RULE_THRESHOLD", operator: "LTE", value: 10, unit: "%", rawText: "10%" }),
      baseNumericalValue({ metric: "cumulative drawdown", role: "RULE_THRESHOLD", operator: "LTE", value: 20, unit: "%", rawText: "20%" }),
    ];
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ numericalValues: values }));
    expect(parsed.numericalValues).toHaveLength(2);
  });
});

// Pre-merge fidelity refinement, item D: exceptions (cases where a rule does
// NOT apply) are separate from conditions (when a rule DOES apply).
describe("KnowledgeItemSchema — exceptions (distinct from conditions)", () => {
  it("allows an empty exceptions array", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ exceptions: [] })).success).toBe(true);
  });

  it("accepts one or more exceptions, kept separate from `conditions`", () => {
    const parsed = KnowledgeItemSchema.parse(
      baseKnowledgeItem({
        statement: "Scale out at HOD / first technical target.",
        conditions: null,
        exceptions: ["On an opening dip-and-rip, HOD may occur inside the entry candle, so standard HOD scaling may not apply the same way."],
      }),
    );
    expect(parsed.exceptions).toHaveLength(1);
    expect(parsed.conditions).toBeNull();
  });

  it("rejects a payload missing exceptions entirely", () => {
    const { exceptions: _omit, ...withoutExceptions } = baseKnowledgeItem();
    expect(KnowledgeItemSchema.safeParse(withoutExceptions).success).toBe(false);
  });
});

describe("LessonExampleSchema — a concrete case study, distinct from a generalized KnowledgeItem", () => {
  it("accepts a well-formed example with an illustratesCategory and outcome", () => {
    expect(LessonExampleSchema.safeParse(baseExample()).success).toBe(true);
  });

  it("allows illustratesCategory and outcome to both be null", () => {
    expect(LessonExampleSchema.safeParse(baseExample({ illustratesCategory: null, outcome: null })).success).toBe(true);
  });

  it("rejects an illustratesCategory that isn't a real KnowledgeCategory value", () => {
    expect(LessonExampleSchema.safeParse(baseExample({ illustratesCategory: "not_a_category" })).success).toBe(false);
  });
});

describe("LessonKnowledgeSchema — the top-level knowledge object", () => {
  it("accepts a fully populated knowledge object across every field", () => {
    const knowledge = emptyKnowledge({
      summary: "Covers risk management and position sizing.",
      knowledgeItems: [baseKnowledgeItem()],
      examples: [baseExample()],
      conflictsAndAmbiguities: ["Unclear whether this applies per-trade or per-day."],
    });
    expect(LessonKnowledgeSchema.safeParse(knowledge).success).toBe(true);
  });

  it("accepts a fully empty knowledge object — a lesson can legitimately have nothing to extract here", () => {
    expect(LessonKnowledgeSchema.safeParse(emptyKnowledge()).success).toBe(true);
  });

  it("rejects a knowledgeItems array containing a malformed item", () => {
    const knowledge = emptyKnowledge({ knowledgeItems: [{ category: "risk_management" }] });
    expect(LessonKnowledgeSchema.safeParse(knowledge).success).toBe(false);
  });
});

// Phase 3.5 provenance (test scenarios #16-20). Unlike PR #11's canonical
// synthesis (which resynthesizes from data Gemini already produced, so it
// keys back into it via `sourceKeys`), lesson analysis is PRIMARY extraction
// straight from video — every timestamp/evidence pair IS the original claim,
// not a reference to one. So provenance here means: (a) Gemini is required
// to produce its own timestamp+evidence per item (never omitted, never a
// bare boolean), (b) the wire schema never asks Gemini to reproduce
// lessonId/lessonTitle/source metadata the application already owns per
// item — that's attached once, deterministically, via the persisted row's
// own DB context/FK — and (c) unknown/invalid category or ruleType values
// are rejected outright rather than silently accepted as some default.
describe("provenance — timestamps, evidence, and no wasteful per-item duplication", () => {
  it("requires a non-empty start_timestamp and evidence on every knowledge item — never optional, never fabricated after the fact", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ start_timestamp: "" })).success).toBe(false);
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ evidence: "" })).success).toBe(false);
  });

  it("round-trips a knowledge item's timestamps and evidence unchanged — provenance survives parsing exactly", () => {
    const parsed = KnowledgeItemSchema.parse(baseKnowledgeItem({ start_timestamp: "12:34", end_timestamp: "13:01", evidence: "Exact quoted instructor line." }));
    expect(parsed.start_timestamp).toBe("12:34");
    expect(parsed.end_timestamp).toBe("13:01");
    expect(parsed.evidence).toBe("Exact quoted instructor line.");
  });

  it("allows end_timestamp to be null for a single-instant knowledge item", () => {
    expect(KnowledgeItemSchema.safeParse(baseKnowledgeItem({ end_timestamp: null })).success).toBe(true);
  });

  it("requires a non-empty start_timestamp and evidence on every example, same as knowledge items", () => {
    expect(LessonExampleSchema.safeParse(baseExample({ start_timestamp: "" })).success).toBe(false);
    expect(LessonExampleSchema.safeParse(baseExample({ evidence: "" })).success).toBe(false);
  });

  // The application already knows lessonId/lessonTitle from the row it's
  // persisting the analysis under — asking Gemini to reproduce them on
  // every one of dozens of items per lesson would be exactly the wasteful
  // repetition PR #11 identified and fixed for synthesis. This is a
  // regression guard: none of the per-item wire schemas ask for it.
  it("never asks Gemini to reproduce lessonId/lessonTitle on knowledgeItems, examples, or numericalValues — that provenance is attached once by the application, not duplicated per item", () => {
    const knowledgeItemProps = Object.keys((STRATEGY_RESPONSE_JSON_SCHEMA.properties.knowledge.properties.knowledgeItems.items as { properties: object }).properties);
    const exampleProps = Object.keys((STRATEGY_RESPONSE_JSON_SCHEMA.properties.knowledge.properties.examples.items as { properties: object }).properties);
    for (const props of [knowledgeItemProps, exampleProps]) {
      expect(props).not.toContain("lessonId");
      expect(props).not.toContain("lessonTitle");
      expect(props).not.toContain("sourceKeys");
    }
  });

  // PR #9's lesson: Gemini's real API rejects ~13 sibling JSON-schema arrays
  // for the same conceptual thing. This guards against silently regressing
  // back to a per-category array shape instead of the collapsed
  // category-tagged `knowledgeItems` array.
  it("keeps the 13 knowledge categories collapsed into ONE knowledgeItems array in the wire schema, not 13 sibling arrays", () => {
    const knowledgeProps = Object.keys(STRATEGY_RESPONSE_JSON_SCHEMA.properties.knowledge.properties);
    expect(knowledgeProps).toEqual(["summary", "knowledgeItems", "examples", "conflictsAndAmbiguities"]);
    expect(knowledgeProps).not.toContain("risk_management");
    expect(knowledgeProps).not.toContain("position_sizing");
  });
});

// Strategy-extraction regression fix (see gemini/schema.ts's changelog): a
// real diagnostic run found strategy_found=false with knowledgeItems that
// clearly named a recognized strategy in scope.strategies — the model
// recognized the setup but never re-populated `strategies`. The fix is
// prompt-only; these tests confirm the SCHEMA still structurally allows
// this exact shape (it must remain valid — it's a legitimate warning
// signal, never a validation failure, per the task's explicit instruction
// not to fail Zod validation solely on this condition) and never
// auto-corrects it.
describe("strategy_found=false with strategy-scoped knowledge — structurally valid, a warning signal only (never a schema failure)", () => {
  it("accepts strategy_found:false + strategies:[] even when a knowledgeItem's scope names a specific strategy", () => {
    const payload = {
      lesson: { title: "Support & Resistance, Key Levels & Market Trends", duration_seconds: 2618 },
      strategy_found: false,
      strategies: [],
      knowledge: emptyKnowledge({
        knowledgeItems: [
          baseKnowledgeItem({
            category: "definitions",
            statement: "The Break and Retest model dictates that broken resistance turns into newly formed support.",
            scope: baseScope({ strategies: ["Break & Retest"] }),
          }),
        ],
      }),
    };
    const result = LessonStrategyAnalysisSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strategy_found).toBe(false);
      expect(result.data.strategies).toEqual([]);
      expect(result.data.knowledge.knowledgeItems[0]?.scope.strategies).toEqual(["Break & Retest"]);
    }
  });

  it("never auto-populates strategies from knowledgeItems — parsing is a pure pass-through, never inference", () => {
    const payload = {
      lesson: { title: "X", duration_seconds: 100 },
      strategy_found: false,
      strategies: [],
      knowledge: emptyKnowledge({ knowledgeItems: [baseKnowledgeItem({ scope: baseScope({ strategies: ["Break & Retest"] }) })] }),
    };
    const result = LessonStrategyAnalysisSchema.parse(payload);
    expect(result.strategies).toEqual([]);
    expect(result.strategy_found).toBe(false);
  });
});

// Non-brittle content assertions (deliberately substring/keyword checks,
// never a full-prompt snapshot) confirming the regression-fix instructions
// are actually present in the shipped prompt.
describe("STRATEGY_EXTRACTION_PROMPT — Task A/Task B independence (regression fix)", () => {
  it("explicitly states Task A and Task B are independent and that overlap is expected, not a reason to skip strategy extraction", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/INDEPENDENT/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/already represented in knowledgeItems/i);
  });

  it("explicitly allows a strategy to qualify with some fields left discretionary, rather than requiring a perfectly complete setup", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/does not need to be perfectly complete/i);
  });

  it("explicitly warns against turning an isolated definition or general principle into a strategy on its own", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/do not turn an isolated definition/i);
  });

  it("repeats the independence reminder near the end of the prompt (bookended), not stated only once where Task B's length can crowd it out", () => {
    const matches = STRATEGY_EXTRACTION_PROMPT.match(/Task A/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

// Final semantic-precision pass: three narrower issues found in the SAME
// real diagnostic output that confirmed the Task A/B regression fix above.
// All three are prompt-only clarifications (no schema change) — these are
// deliberately non-brittle substring/keyword checks, never a full-prompt
// snapshot, since we can't unit-test what the real Gemini API returns.
describe("STRATEGY_EXTRACTION_PROMPT — scope/applicability vs. examples (test requirements 1-2)", () => {
  it("explicitly instructs that scope arrays represent applicability restrictions, not every ticker/instrument demonstrated as an example", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/SCOPE ARRAYS REPRESENT APPLICABILITY, NOT EXAMPLES/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/does NOT apply outside this value/i);
  });

  it("gives the AAPL/AMD/AMZN/TSLA-style contamination as a concrete negative example for scope", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/AAPL, AMD, AMZN, and TSLA/);
  });

  it("explicitly clarifies Strategy.market_or_instrument/timeframes are applicability restrictions, not a list of every demonstrated instrument", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/APPLICABILITY RESTRICTIONS, not a list of every ticker/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/AMD\/NVDA belong in "examples_shown"/);
  });
});

describe("STRATEGY_EXTRACTION_PROMPT — BETWEEN vs. GTE operator selection (test requirements 3-5)", () => {
  it("instructs BETWEEN only for a true bounded range, both endpoints being genuine restrictions", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/BETWEEN is for a TRUE BOUNDED RANGE ONLY/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/risk between 1% and 5%/);
  });

  it("instructs an open-ended 'more is better' concept must use GTE with the true lower bound, never BETWEEN with a false upper bound", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/two to three touches establish a level, and more touches make it stronger/i);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/must be GTE with value=2.*value2=null/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/NEVER BETWEEN with value2=3/);
  });

  it("still preserves 'at least N' as GTE (unaffected baseline behavior)", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/"at least"\/"minimum" is GTE/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/at least 6 months/);
  });
});

describe("STRATEGY_EXTRACTION_PROMPT — atomicity across applicability regimes (test requirement 6)", () => {
  it("explicitly instructs splitting materially different trader-profile/instrument/strategy/session regimes into separate scoped items", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/SPLIT ON MATERIALLY DIFFERENT APPLICABILITY/);
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/beginners should risk 1-5%.*experienced traders/i);
  });

  it("reserves exceptions for a true carve-out under one parent rule, distinct from a fundamentally different rule for a different population", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/Reserve "exceptions" for a TRUE exception to one parent rule/);
  });

  it("directs a genuine conflict between split regimes into conflictsAndAmbiguities", () => {
    expect(STRATEGY_EXTRACTION_PROMPT).toMatch(/also add an entry to "conflictsAndAmbiguities"/);
  });
});
