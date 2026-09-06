import { describe, it, expect, vi } from "vitest";
import type { KnowledgeItem, KnowledgeItemScope } from "../src/gemini/schema.js";
import type { GeminiClient, GeminiUsage } from "../src/gemini/client.js";
import { normalizeLessonKnowledge, collectRawStrategyScopeNames, type LessonKnowledgeSource } from "../src/synthesis/knowledgeNormalize.js";
import { keyFacts, resolveKeys, type CitableFact } from "../src/synthesis/sourceRegistry.js";
import {
  deterministicMapScopeNames,
  resolveStrategyScopeNames,
  buildClusterCandidates,
  type ClusterCandidate,
} from "../src/synthesis/strategyScopeMapping.js";
import { synthesizeCanonicalStrategy, enrichCanonicalStrategy } from "../src/synthesis/canonicalStrategy.js";
import { extractCoreFramework } from "../src/synthesis/coreFramework.js";
import type { KnowledgeItemRecord } from "../src/synthesis/knowledgeNormalize.js";
import type { StrategyInstanceRecord } from "../src/synthesis/normalize.js";
import type { Strategy } from "../src/gemini/schema.js";
import type { CanonicalStrategy, ClusterProposal, RawCanonicalStrategy } from "../src/synthesis/schema.js";

const usage: GeminiUsage = { inputTokens: 10, outputTokens: 5, thinkingTokens: 0 };

function emptyScope(overrides: Partial<KnowledgeItemScope> = {}): KnowledgeItemScope {
  return { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [], ...overrides };
}

function makeKnowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    category: "risk_management",
    statement: "Never risk more than 1% of account per trade.",
    ruleType: "HARD_RULE",
    classification: "explicit",
    confidence: 0.95,
    conditions: null,
    exceptions: [],
    scope: emptyScope(),
    numericalValues: [
      { metric: "account risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "no more than 1%", context: "risk per trade" },
    ],
    start_timestamp: "1:00",
    end_timestamp: null,
    evidence: "Instructor states never risk more than 1%.",
    ...overrides,
  };
}

function makeGemini(overrides: Partial<GeminiClient> = {}): GeminiClient {
  return {
    uploadFile: vi.fn(),
    waitUntilActive: vi.fn(),
    analyzeVideo: vi.fn(),
    deleteFile: vi.fn(),
    generateStructured: vi.fn(async () => ({ text: "{}", usage })),
    ...overrides,
  };
}

describe("synthesis/knowledgeNormalize", () => {
  it("flattens knowledgeItems/examples across lessons and splits global vs scoped", () => {
    const sources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Risk Management",
        knowledge: {
          summary: "s",
          knowledgeItems: [
            makeKnowledgeItem({ statement: "global rule" }),
            makeKnowledgeItem({ statement: "strategy scoped", scope: emptyScope({ strategies: ["Break & Retest"] }) }),
            makeKnowledgeItem({ statement: "instrument scoped only", scope: emptyScope({ marketsOrInstruments: ["0-DTE options"] }) }),
          ],
          examples: [{ description: "ex", illustratesCategory: "risk_management", outcome: null, start_timestamp: "2:00", end_timestamp: null, evidence: "e" }],
          conflictsAndAmbiguities: [],
        },
      },
    ];

    const normalized = normalizeLessonKnowledge(sources);
    expect(normalized.items).toHaveLength(3);
    expect(normalized.examples).toHaveLength(1);
    expect(normalized.globalItems.map((r) => r.item.statement)).toEqual(["global rule"]);
    expect(normalized.scopedItems).toHaveLength(2);
    expect(normalized.strategyScopedItems.map((r) => r.item.statement)).toEqual(["strategy scoped"]);
    expect(normalized.otherScopedItems.map((r) => r.item.statement)).toEqual(["instrument scoped only"]);
    expect(normalized.items.every((r) => r.lessonId === 10 && r.lessonTitle === "Risk Management" && r.analysisId === 1)).toBe(true);
  });

  it("also flattens knowledge from no_strategy lessons — this is the whole point of Phase 3.5B (Phase 3.4 never read these at all)", () => {
    const sources: LessonKnowledgeSource[] = [
      {
        analysisId: 2,
        lessonId: 11,
        lessonTitle: "Sizing & Scaling Trades",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ category: "position_sizing", statement: "size by contract count" })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const normalized = normalizeLessonKnowledge(sources);
    expect(normalized.items).toHaveLength(1);
    expect(normalized.globalItems).toHaveLength(1);
  });

  it("collectRawStrategyScopeNames dedupes across items", () => {
    const records: KnowledgeItemRecord[] = [
      { lessonId: 1, lessonTitle: "L1", analysisId: 1, isScoped: true, item: makeKnowledgeItem({ scope: emptyScope({ strategies: ["Break & Retest"] }) }) },
      { lessonId: 2, lessonTitle: "L2", analysisId: 2, isScoped: true, item: makeKnowledgeItem({ scope: emptyScope({ strategies: ["Break & Retest", "Order Block"] }) }) },
    ];
    expect(collectRawStrategyScopeNames(records).sort()).toEqual(["Break & Retest", "Order Block"]);
  });
});

describe("synthesis/sourceRegistry", () => {
  it("keys facts in order and resolves citations back to full SourceRef, dropping unknown keys", () => {
    const fact1: CitableFact = { lessonId: 10, lessonTitle: "L10", strategyInstanceId: null, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" };
    const fact2: CitableFact = { lessonId: 11, lessonTitle: "L11", strategyInstanceId: 5, startTimestamp: "2:00", endTimestamp: "2:30", evidence: "e2" };
    const { promptItems, keyMap } = keyFacts([
      { fact: fact1, payload: { statement: "a" } },
      { fact: fact2, payload: { statement: "b" } },
    ]);

    expect(promptItems).toEqual([
      { statement: "a", key: "k1" },
      { statement: "b", key: "k2" },
    ]);

    const resolved = resolveKeys(["k1", "k2", "k99"], keyMap);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual({ lessonId: 10, lessonTitle: "L10", strategyInstanceId: null, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" });
    expect(resolved[1].strategyInstanceId).toBe(5);
  });
});

describe("synthesis/strategyScopeMapping — deterministic tier", () => {
  const clusters: ClusterCandidate[] = [
    { clusterKey: "br", proposedCanonicalName: "Break and Retest", memberNames: ["Break & Retest", "Premarket Break and Retest"] },
    { clusterKey: "ob", proposedCanonicalName: "Order Block Continuation", memberNames: ["Order Block Retest"] },
  ];

  it("matches exact and punctuation/case-insensitive names", () => {
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["Break & Retest", "break and retest", "BREAK-AND-RETEST"], clusters);
    expect(mapped.get("Break & Retest")).toBe("br");
    expect(mapped.get("break and retest")).toBe("br");
    expect(mapped.get("BREAK-AND-RETEST")).toBe("br");
    expect(unmatchedNames).toEqual([]);
  });

  it("matches via containment against a member's original name", () => {
    const { mapped } = deterministicMapScopeNames(["Order Block"], clusters);
    // "order block" is contained in normalized "order block retest"
    expect(mapped.get("Order Block")).toBe("ob");
  });

  it("does not resolve an initialism deterministically — falls through to unmatched for the Gemini tier", () => {
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["B&R"], clusters);
    expect(mapped.has("B&R")).toBe(false);
    expect(unmatchedNames).toEqual(["B&R"]);
  });

  it("never spuriously matches an unrelated name", () => {
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["Fibonacci Retracement"], clusters);
    expect(mapped.size).toBe(0);
    expect(unmatchedNames).toEqual(["Fibonacci Retracement"]);
  });

  it("buildClusterCandidates pulls original strategy names from matching member instances", () => {
    const instances: StrategyInstanceRecord[] = [
      { strategyInstanceId: 1, lessonId: 1, lessonTitle: "L1", analysisId: 1, strategyName: "Break & Retest", normalizedName: "break & retest", strategy: {} as Strategy },
    ];
    const proposals: ClusterProposal[] = [{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }];
    const candidates = buildClusterCandidates(proposals, instances);
    expect(candidates).toEqual([{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberNames: ["Break & Retest"] }]);
  });
});

describe("synthesis/strategyScopeMapping — Gemini fallback tier", () => {
  const clusters: ClusterCandidate[] = [{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberNames: ["Break & Retest"] }];

  it("only calls Gemini for names the deterministic tier could not place", async () => {
    const generateStructured = vi.fn(async (_prompt: string) => ({
      text: JSON.stringify({ mappings: [{ rawName: "B&R", clusterKey: "br" }] }),
      usage,
    }));
    const gemini = makeGemini({ generateStructured });

    const { result, usage: returnedUsage } = await resolveStrategyScopeNames({ gemini, model: "m" }, ["Break and Retest", "B&R"], clusters);

    expect(generateStructured).toHaveBeenCalledTimes(1);
    const promptArg = generateStructured.mock.calls[0][0];
    expect(promptArg).toContain("B&R");
    expect(promptArg).not.toContain('"Break and Retest"]'); // already resolved deterministically, not sent to Gemini as unmatched
    expect(result.mapped.get("Break and Retest")).toBe("br");
    expect(result.mapped.get("B&R")).toBe("br");
    expect(result.unmatchedNames).toEqual([]);
    expect(returnedUsage).toEqual(usage);
  });

  it("skips the Gemini call entirely when nothing is left to resolve", async () => {
    const generateStructured = vi.fn(async () => ({ text: JSON.stringify({ mappings: [] }), usage }));
    const gemini = makeGemini({ generateStructured });

    const { usage: returnedUsage } = await resolveStrategyScopeNames({ gemini, model: "m" }, ["Break and Retest"], clusters);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(returnedUsage).toBeNull();
  });

  it("never drops a name Gemini also could not confidently place — surfaces it as unmatched", async () => {
    const generateStructured = vi.fn(async () => ({
      text: JSON.stringify({ mappings: [{ rawName: "Fibonacci Retracement", clusterKey: null }] }),
      usage,
    }));
    const gemini = makeGemini({ generateStructured });

    const { result } = await resolveStrategyScopeNames({ gemini, model: "m" }, ["Fibonacci Retracement"], clusters);
    expect(result.mapped.has("Fibonacci Retracement")).toBe(false);
    expect(result.unmatchedNames).toEqual(["Fibonacci Retracement"]);
  });

  it("rejects a Gemini-proposed clusterKey that doesn't actually exist, rather than trusting it blindly", async () => {
    const generateStructured = vi.fn(async () => ({
      text: JSON.stringify({ mappings: [{ rawName: "B&R", clusterKey: "invented-cluster-key" }] }),
      usage,
    }));
    const gemini = makeGemini({ generateStructured });

    const { result } = await resolveStrategyScopeNames({ gemini, model: "m" }, ["B&R"], clusters);
    expect(result.mapped.has("B&R")).toBe(false);
    expect(result.unmatchedNames).toEqual(["B&R"]);
  });
});

function makeInstance(overrides: Partial<StrategyInstanceRecord> = {}): StrategyInstanceRecord {
  return {
    strategyInstanceId: 1,
    lessonId: 10,
    lessonTitle: "Lesson 10",
    analysisId: 100,
    strategyName: "Break & Retest",
    normalizedName: "break & retest",
    strategy: {
      strategy_name: "Break & Retest",
      market_or_instrument: ["ES"],
      timeframes: ["5m"],
      indicators: [],
      setup_conditions: [],
      entry_rules: [{ description: "Enter on retest", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "e" }],
      confirmation_rules: [],
      stop_loss_rules: [],
      profit_target_rules: [],
      trade_management_rules: [],
      invalidation_rules: [],
      no_trade_conditions: [],
      market_context_rules: [],
      visual_discretionary_rules: [],
      examples_shown: [],
      ambiguities: [],
    },
    ...overrides,
  };
}

describe("synthesis/canonicalStrategy — Phase 3.5B knowledge enrichment", () => {
  it("cites a knowledge-item key in a new category and deterministically attaches its numericalValues/exceptions/scope — never asked of Gemini directly", () => {
    const scopedKnowledge: KnowledgeItemRecord[] = [
      {
        lessonId: 20,
        lessonTitle: "Sizing & Scaling Trades",
        analysisId: 200,
        isScoped: true,
        item: makeKnowledgeItem({
          category: "position_sizing",
          statement: "Risk 1-5% depending on setup quality",
          scope: emptyScope({ strategies: ["Break & Retest"], traderProfiles: ["beginner"] }),
          exceptions: ["Experienced traders may size by contract count instead."],
          numericalValues: [
            { metric: "account risk per trade", operator: "BETWEEN", value: 1, value2: 5, unit: "%", role: "RULE_THRESHOLD", rawText: "1% to 5%", context: "position sizing" },
          ],
        }),
      },
    ];

    const raw: RawCanonicalStrategy = {
      name: "Break & Retest",
      purpose: "p",
      markets: ["ES"],
      timeframes: ["5m"],
      sections: [
        {
          category: "positionSizingRules",
          rules: [
            {
              description: "Risk 1-5% of account per trade based on setup quality.",
              classification: "explicit",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sourceKeys: ["k1"],
              conflictSourceKeys: [],
              exceptions: [],
              numericalValues: [],
              scope: null,
            },
          ],
        },
      ],
      variants: [],
      examples: [],
      ambiguities: [],
      conflicts: [],
      sourceLessonIds: [10],
    };

    const enriched = enrichCanonicalStrategy(raw, [makeInstance()], scopedKnowledge);

    expect(enriched.positionSizingRules).toHaveLength(1);
    const rule = enriched.positionSizingRules[0];
    expect(rule.sources).toEqual([
      { lessonId: 20, lessonTitle: "Sizing & Scaling Trades", strategyInstanceId: null, startTimestamp: "1:00", endTimestamp: null, evidence: "Instructor states never risk more than 1%." },
    ]);
    expect(rule.numericalValues).toEqual([
      { metric: "account risk per trade", operator: "BETWEEN", value: 1, value2: 5, unit: "%", role: "RULE_THRESHOLD", rawText: "1% to 5%", context: "position sizing" },
    ]);
    expect(rule.exceptions).toEqual(["Experienced traders may size by contract count instead."]);
    expect(rule.scope).toEqual(emptyScope({ strategies: ["Break & Retest"], traderProfiles: ["beginner"] }));

    // The pre-existing 11 categories are completely unaffected — same behavior as before Phase 3.5B.
    expect(enriched.entryRules).toEqual([]);
  });

  it("a rule citing only a strategy-instance ('s'-prefixed) key gets empty numericalValues/exceptions/null scope — unchanged pre-3.5B behavior", () => {
    const raw: RawCanonicalStrategy = {
      name: "Break & Retest",
      purpose: "p",
      markets: ["ES"],
      timeframes: ["5m"],
      sections: [
        {
          category: "entryRules",
          rules: [
            { description: "Enter on retest", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["s1"], conflictSourceKeys: [], exceptions: [], numericalValues: [], scope: null },
          ],
        },
      ],
      variants: [],
      examples: [],
      ambiguities: [],
      conflicts: [],
      sourceLessonIds: [10],
    };

    const enriched = enrichCanonicalStrategy(raw, [makeInstance()]);
    expect(enriched.entryRules[0].numericalValues).toEqual([]);
    expect(enriched.entryRules[0].exceptions).toEqual([]);
    expect(enriched.entryRules[0].scope).toBeNull();
  });

  it("synthesizeCanonicalStrategy passes scoped knowledge into the prompt and resolves the model's k-key citations end to end", async () => {
    let capturedPrompt = "";
    const generateStructured = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        text: JSON.stringify({
          name: "Break & Retest",
          purpose: "p",
          markets: ["ES"],
          timeframes: ["5m"],
          sections: [
            {
              category: "warnings",
              rules: [{ description: "Do not oversize on a low-quality setup.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }],
            },
          ],
          variants: [],
          examples: [],
          ambiguities: [],
          conflicts: [],
          sourceLessonIds: [10],
        }),
        usage,
      };
    });
    const gemini = makeGemini({ generateStructured });
    const cluster: ClusterProposal = { clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" };
    const scopedKnowledge: KnowledgeItemRecord[] = [
      { lessonId: 20, lessonTitle: "Warnings Lesson", analysisId: 200, isScoped: true, item: makeKnowledgeItem({ category: "warnings", ruleType: "WARNING", statement: "don't oversize" }) },
    ];

    const { canonicalStrategy } = await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, [makeInstance()], {}, scopedKnowledge);

    expect(capturedPrompt).toContain("k1");
    expect(capturedPrompt).toContain("Warnings Lesson");
    expect(canonicalStrategy.warnings).toHaveLength(1);
    expect(canonicalStrategy.warnings[0].sources[0].lessonTitle).toBe("Warnings Lesson");
  });
});

describe("synthesis/coreFramework — Phase 3.5B course-wide knowledge pooling", () => {
  const canonicalStrategy: CanonicalStrategy = {
    name: "Break & Retest",
    purpose: "p",
    markets: [],
    timeframes: [],
    marketContext: [],
    prerequisites: [],
    setup: [],
    entryRules: [],
    confirmationRules: [],
    stopLossRules: [],
    profitTargetRules: [],
    tradeManagementRules: [],
    invalidationRules: [],
    noTradeConditions: [],
    visualDiscretionaryRules: [],
    riskManagementRules: [],
    positionSizingRules: [],
    scalingInRules: [],
    scalingOutRules: [],
    runnerManagementRules: [],
    warnings: [],
    instructorPreferences: [],
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
    sourceLessonIds: [],
  };

  it("pools GLOBAL knowledge items (a lesson with no standalone setup) into the course-wide framework — this was the exact gap Phase 3.4 left open", async () => {
    // "Sizing & Scaling Trades" — strategy_found=false, but rich knowledge exists.
    const courseKnowledge: KnowledgeItemRecord[] = [
      {
        lessonId: 30,
        lessonTitle: "Sizing & Scaling Trades",
        analysisId: 300,
        isScoped: false,
        item: makeKnowledgeItem({
          category: "risk_management",
          statement: "Never risk more than 1% of account per trade.",
          numericalValues: [{ metric: "account risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "no more than 1%", context: "risk" }],
        }),
      },
    ];

    let capturedPrompt = "";
    const generateStructured = vi.fn(async (prompt: string) => {
      capturedPrompt = prompt;
      return {
        text: JSON.stringify({
          sections: [
            {
              key: "risk_framework",
              title: "Risk Framework",
              rules: [{ description: "Risk no more than 1% per trade.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }],
            },
          ],
        }),
        usage,
      };
    });
    const gemini = makeGemini({ generateStructured });

    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [canonicalStrategy], [], courseKnowledge);

    expect(capturedPrompt).toContain("Sizing & Scaling Trades");
    expect(coreFramework.sections[0].rules[0].sources[0].lessonTitle).toBe("Sizing & Scaling Trades");
    expect(coreFramework.sections[0].rules[0].numericalValues).toEqual([
      { metric: "account risk per trade", operator: "LTE", value: 1, value2: null, unit: "%", role: "RULE_THRESHOLD", rawText: "no more than 1%", context: "risk" },
    ]);
  });

  it("preserves an instrument/timeframe/session/trader-profile scope tag on a pooled global-framework rule rather than flattening it into a universal rule", async () => {
    const courseKnowledge: KnowledgeItemRecord[] = [
      {
        lessonId: 31,
        lessonTitle: "0-DTE Options Sizing",
        analysisId: 301,
        isScoped: true,
        item: makeKnowledgeItem({
          category: "position_sizing",
          statement: "Size 0-DTE options much smaller than swing positions.",
          scope: emptyScope({ marketsOrInstruments: ["0-DTE options"] }),
        }),
      },
    ];
    const generateStructured = vi.fn(async () => ({
      text: JSON.stringify({
        sections: [
          {
            key: "position_sizing",
            title: "Position Sizing & Scaling",
            rules: [{ description: "Size 0-DTE options smaller.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }],
          },
        ],
      }),
      usage,
    }));
    const gemini = makeGemini({ generateStructured });

    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [canonicalStrategy], [], courseKnowledge);
    expect(coreFramework.sections[0].rules[0].scope).toEqual(emptyScope({ marketsOrInstruments: ["0-DTE options"] }));
  });

  it("still pools cross-strategy strategy_instance rules exactly as before (pre-3.5B behavior) when no course knowledge is passed", async () => {
    const generateStructured = vi.fn(async () => ({
      text: JSON.stringify({
        sections: [
          { key: "risk_framework", title: "Risk Framework", rules: [{ description: "d", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] },
        ],
      }),
      usage,
    }));
    const gemini = makeGemini({ generateStructured });
    const instance = makeInstance({ strategy: { ...makeInstance().strategy, market_context_rules: [{ description: "d", classification: "explicit", confidence: 0.9, start_timestamp: "0:10", end_timestamp: null, evidence: "e" }] } });

    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [canonicalStrategy], [instance]);
    expect(coreFramework.sections[0].rules[0].sources[0].lessonId).toBe(10);
    expect(coreFramework.sections[0].rules[0].numericalValues).toEqual([]);
    expect(coreFramework.sections[0].rules[0].scope).toBeNull();
  });
});
