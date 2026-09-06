import { describe, it, expect, vi } from "vitest";
import type { GeminiClient, GeminiUsage } from "../src/gemini/client.js";
import { runSynthesis, type RunSynthesisInput } from "../src/synthesis/runSynthesis.js";
import type { StrategyInstanceRecord } from "../src/synthesis/normalize.js";
import type { Strategy, KnowledgeItem, KnowledgeItemScope } from "../src/gemini/schema.js";
import type { LessonKnowledgeSource } from "../src/synthesis/knowledgeNormalize.js";

/**
 * Real-audit fix regression tests (Phase 3.5B follow-up) — see PR #13's
 * real 28-lesson dry-run audit. Each test below maps to one numbered
 * blocker from that audit.
 */

const usage: GeminiUsage = { inputTokens: 100, outputTokens: 50, thinkingTokens: 10 };

function emptyScope(overrides: Partial<KnowledgeItemScope> = {}): KnowledgeItemScope {
  return { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [], ...overrides };
}

function makeKnowledgeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    category: "risk_management",
    statement: "statement",
    ruleType: "HARD_RULE",
    classification: "explicit",
    confidence: 0.9,
    conditions: null,
    exceptions: [],
    scope: emptyScope(),
    numericalValues: [],
    start_timestamp: "0:00",
    end_timestamp: null,
    evidence: "e",
    ...overrides,
  };
}

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    strategy_name: "Strategy",
    market_or_instrument: [],
    timeframes: [],
    indicators: [],
    setup_conditions: [],
    entry_rules: [{ description: "entry", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
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
    ...overrides,
  };
}

function makeInstance(overrides: Partial<StrategyInstanceRecord> = {}): StrategyInstanceRecord {
  return {
    strategyInstanceId: 1,
    lessonId: 10,
    lessonTitle: "Lesson 10",
    analysisId: 100,
    strategyName: "Strategy",
    normalizedName: "strategy",
    strategy: makeStrategy(),
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

function rawCanonicalStrategyJson(name: string) {
  return JSON.stringify({
    name,
    purpose: "p",
    markets: [],
    timeframes: [],
    sections: [],
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
  });
}

describe("Real-audit Blocker 1 — deterministic canonical strategy library completeness", () => {
  it("16 canonical strategies in -> exactly 16 strategy-library entries out, never dependent on Gemini's own count", async () => {
    const strategyNames = Array.from({ length: 16 }, (_, i) => `Strategy ${i + 1}`);
    const instances = strategyNames.map((name, i) =>
      makeInstance({ strategyInstanceId: i + 1, lessonId: i + 1, lessonTitle: `Lesson ${i + 1}`, strategyName: name, strategy: makeStrategy({ strategy_name: name }) }),
    );

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) {
          return {
            text: JSON.stringify({
              clusters: strategyNames.map((name, i) => ({
                clusterKey: `c${i + 1}`,
                proposedCanonicalName: name,
                memberInstanceIds: [i + 1],
                similarityRationale: "r",
                differencesNotes: "",
              })),
            }),
            usage,
          };
        }
        if (prompt.includes("synthesizing ONE canonical trading strategy")) {
          const nameMatch = /clustered together as "([^"]+)"/.exec(prompt);
          return { text: rawCanonicalStrategyJson(nameMatch?.[1] ?? "Unknown"), usage };
        }
        if (prompt.includes("Core Trading Framework")) return { text: JSON.stringify({ sections: [] }), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) {
          // Deliberately mimics the real audit finding: Gemini's own prose undercounts (says 15, not 16) — the deterministic section must correct this, not defer to it.
          return {
            text: JSON.stringify({
              title: "Playbook",
              sections: [
                { key: "course_philosophy", title: "Philosophy", content: "p" },
                { key: "pre_market_preparation", title: "Prep", content: "p" },
                { key: "higher_timeframe_framework", title: "HTF", content: "p" },
                { key: "market_context_regime", title: "Regime", content: "p" },
                { key: "key_levels", title: "Levels", content: "p" },
                { key: "setup_selection", title: "Setup", content: "The playbook recognizes fifteen canonical strategies." },
                { key: "entry_framework", title: "Entry", content: "e" },
                { key: "confirmation_framework", title: "Confirmation", content: "c" },
                { key: "risk_management", title: "Risk", content: "r" },
                { key: "stop_placement", title: "Stops", content: "s" },
                { key: "target_selection", title: "Targets", content: "t" },
                { key: "trade_management", title: "Management", content: "m" },
                { key: "no_trade_conditions", title: "No Trade", content: "n" },
                { key: "strategy_variants", title: "Variants", content: "v" },
                { key: "common_mistakes_warnings", title: "Warnings", content: "w" },
                { key: "conflicts_and_ambiguities", title: "Conflicts", content: "c" },
                { key: "master_trading_checklist", title: "Checklist", content: "ck" },
              ],
              conflictsAndAmbiguities: [],
            }),
            usage,
          };
        }
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const input: RunSynthesisInput = {
      courseTitle: "Trading Accelerator",
      instances,
      lessons: instances.map((i) => ({ id: i.lessonId, title: i.lessonTitle, chapterTitle: null, sourceUrl: "https://x" })),
      noStandaloneSetupLessonIds: [],
      knowledgeSources: [],
    };

    const result = await runSynthesis({ gemini, model: "m" }, input);
    expect(result.clusters).toHaveLength(16);

    const library = result.playbook.sections.find((s) => s.key === "canonical_strategy_library");
    expect(library).toBeDefined();
    expect(library!.content).toContain("exactly 16 distinct canonical strategy");
    for (const name of strategyNames) {
      expect(library!.content).toContain(name);
    }
  });
});

describe("Real-audit Blocker 3 — Source Index distinguishes taught vs supporting knowledge", () => {
  it("a strategy_found=false lesson contributing scoped knowledge is never listed as having taught the strategy", async () => {
    // "Stocks" — strategy_found=false, contributes B&R-scoped supporting knowledge only.
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 2,
        lessonId: 11,
        lessonTitle: "Stocks",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "Risk 1% on B&R setups.", scope: emptyScope({ strategies: ["Break and Retest"] }) })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) {
          return { text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }] }), usage };
        }
        if (prompt.includes("synthesizing ONE canonical trading strategy")) {
          const sourceKeys = prompt.includes('"key": "k1"') ? ["k1"] : [];
          return {
            text: JSON.stringify({
              name: "Break and Retest",
              purpose: "p",
              markets: [],
              timeframes: [],
              sections: sourceKeys.length > 0 ? [{ category: "riskManagementRules", rules: [{ description: "Risk 1%", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys, conflictSourceKeys: [] }] }] : [],
              variants: [],
              examples: [],
              ambiguities: [],
              conflicts: [],
            }),
            usage,
          };
        }
        if (prompt.includes("Core Trading Framework")) return { text: JSON.stringify({ sections: [] }), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const input: RunSynthesisInput = {
      courseTitle: "Trading Accelerator",
      instances: [makeInstance({ strategyInstanceId: 1, lessonId: 10, lessonTitle: "Break and Retest Lesson", strategyName: "Break and Retest", strategy: makeStrategy({ strategy_name: "Break and Retest" }) })],
      lessons: [
        { id: 10, title: "Break and Retest Lesson", chapterTitle: null, sourceUrl: "https://x" },
        { id: 11, title: "Stocks", chapterTitle: null, sourceUrl: "https://y" },
      ],
      noStandaloneSetupLessonIds: [11],
      knowledgeSources,
    };

    const result = await runSynthesis({ gemini, model: "m" }, input);
    const canonicalStrategy = result.clusters[0].canonicalStrategy;

    // Deterministic provenance fields: Stocks never taught the setup, but did support it.
    expect(canonicalStrategy.sourceLessonIds).toEqual([10]);
    expect(canonicalStrategy.supportingKnowledgeLessonIds).toEqual([11]);

    const sourceIndex = result.playbook.sections.find((s) => s.key === "source_index");
    const lines = sourceIndex!.content.split("\n");
    const stocksLineIndex = lines.findIndex((l) => l.includes("- Stocks"));
    expect(stocksLineIndex).toBeGreaterThanOrEqual(0);
    // "Stocks" must say it taught NO standalone strategy...
    expect(lines[stocksLineIndex + 1]).toContain("Standalone strategies taught: none");
    // ...but DOES separately show supporting canonical strategy knowledge.
    expect(lines[stocksLineIndex + 2]).toContain("Supporting canonical strategy knowledge: Break and Retest");

    const brLineIndex = lines.findIndex((l) => l.includes("Break and Retest Lesson"));
    expect(lines[brLineIndex + 1]).toContain("Standalone strategies taught: Break and Retest");
  });
});

describe("Real-audit Blocker 8 — frameworkCoverage wording vs strategy-scope-mapping completeness", () => {
  it("frameworkCoverage.status COMPLETE never implies strategy-scope mapping is complete when scopes remain unmatched", async () => {
    const fullDimensionKnowledge = (lessonId: number, lessonTitle: string): KnowledgeItem[] => {
      const categories = [
        "market_context", "risk_management", "position_sizing", "scaling_in", "scaling_out",
        "trade_management", "execution", "higher_timeframe", "preparation", "psychology",
        "no_trade_conditions", "warnings", "definitions",
      ] as const;
      return categories.map((category) => makeKnowledgeItem({ category, statement: `${category} @ ${lessonTitle}` }));
    };

    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Everything Lesson",
        knowledge: {
          summary: "s",
          knowledgeItems: [
            ...fullDimensionKnowledge(10, "Everything Lesson"),
            // An unmatchable strategy-scoped item — "Fibonacci Retracement" is not a real cluster below.
            makeKnowledgeItem({ category: "risk_management", statement: "Fib-specific risk rule", scope: emptyScope({ strategies: ["Fibonacci Retracement"] }) }),
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) {
          return { text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }] }), usage };
        }
        if (prompt.includes("synthesizing ONE canonical trading strategy")) return { text: rawCanonicalStrategyJson("Break and Retest"), usage };
        if (prompt.includes("Core Trading Framework")) return { text: JSON.stringify({ sections: [] }), usage };
        if (prompt.includes("matching strategy names")) return { text: JSON.stringify({ mappings: [{ rawName: "Fibonacci Retracement", clusterKey: null }] }), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const input: RunSynthesisInput = {
      courseTitle: "Trading Accelerator",
      instances: [makeInstance({ strategyInstanceId: 1, lessonId: 10, lessonTitle: "Everything Lesson", strategyName: "Break and Retest", strategy: makeStrategy({ strategy_name: "Break and Retest" }) })],
      lessons: [{ id: 10, title: "Everything Lesson", chapterTitle: null, sourceUrl: "https://x" }],
      noStandaloneSetupLessonIds: [],
      knowledgeSources,
    };

    const result = await runSynthesis({ gemini, model: "m" }, input);

    // Framework dimension coverage IS complete (every dimension has evidence)...
    expect(result.playbook.frameworkCoverage.status).toBe("COMPLETE");
    expect(result.playbook.frameworkCoverage.coverageNote).not.toContain("Strategy synthesis complete");

    // ...but strategy-scope mapping is a SEPARATE, independent signal that is NOT complete.
    expect(result.playbook.strategyScopeMapping.completeness).toBe("PARTIAL");
    expect(result.playbook.strategyScopeMapping.unmatchedRawNames).toEqual(["Fibonacci Retracement"]);
    expect(result.playbook.strategyScopeMapping.unmatchedItemCount).toBe(1);

    const unmatchedSection = result.playbook.sections.find((s) => s.key === "unmatched_strategy_scoped_knowledge");
    expect(unmatchedSection).toBeDefined();
    expect(unmatchedSection!.content).toContain("Fibonacci Retracement");
  });
});

describe("Real-audit Blockers 4/5 — decision framework must not globalize scoped rules", () => {
  it("splits coreFramework into GLOBAL and SCOPED pools in the prompt, never blending a scoped rule into the global one", async () => {
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const canonicalStrategy = JSON.parse(rawCanonicalStrategyJson("Break and Retest"));
    const fullCanonicalStrategy = {
      ...canonicalStrategy,
      marketContext: [], prerequisites: [], setup: [], entryRules: [], confirmationRules: [], stopLossRules: [],
      profitTargetRules: [], tradeManagementRules: [], invalidationRules: [], noTradeConditions: [], visualDiscretionaryRules: [],
      riskManagementRules: [], positionSizingRules: [], scalingInRules: [], scalingOutRules: [], runnerManagementRules: [],
      warnings: [], instructorPreferences: [], sourceLessonIds: [], supportingKnowledgeLessonIds: [],
    };

    const coreFramework = {
      sections: [
        {
          key: "risk",
          title: "Risk",
          rules: [
            { description: "Always define risk before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null },
            {
              description: "Trade only 9:30-11:00 AM ET.",
              classification: "explicit",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sources: [],
              conflictSources: [],
              exceptions: [],
              numericalValues: [],
              scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: ["1m", "5m"], sessions: ["market-open"], traderProfiles: [] },
            },
          ],
        },
      ],
    };

    await synthesizeDecisionFramework({ gemini, model: "m" }, [fullCanonicalStrategy], coreFramework as never);

    expect(capturedPrompt).toContain("GLOBAL course-wide framework rules");
    expect(capturedPrompt).toContain("SCOPED course-wide framework rules");
    expect(capturedPrompt).toContain("Always define risk before entry.");
    expect(capturedPrompt).toContain("Trade only 9:30-11:00 AM ET.");
    expect(capturedPrompt).toContain("9:30-11:00 AM");
    // The scoped rule's own scope object must actually appear in the SCOPED pool text (not stripped out as a bare string).
    expect(capturedPrompt).toContain('"marketsOrInstruments"');

    // Split the prompt at the SCOPED-pool marker: the global-only rule must appear before it, the scoped rule's restriction detail must appear after it.
    const scopedPoolIndex = capturedPrompt.indexOf("SCOPED course-wide framework rules");
    const globalRuleIndex = capturedPrompt.indexOf("Always define risk before entry.");
    expect(globalRuleIndex).toBeLessThan(scopedPoolIndex);
  });

  it("findGlobalGateScopeLeaks flags a scoped rule placed on the unconditional path before strategy selection (the exact real-audit failure)", async () => {
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const badDecisionFramework = {
      nodes: [
        { id: "start", type: "start" as const, label: "Start", description: null, next: ["session-gate"], branches: [], scope: emptyScope() },
        {
          // The exact real-audit failure: a 9:30-11am/options/1m-5m-scoped rule placed as an UNCONDITIONAL gate.
          id: "session-gate",
          type: "action" as const,
          label: "Trending & Normal Session (9:30 - 11:00 AM EST...)",
          description: null,
          next: ["pick-strategy"],
          branches: [],
          scope: emptyScope({ marketsOrInstruments: ["options"], timeframes: ["1m", "5m"], sessions: ["market-open"] }),
        },
        { id: "pick-strategy", type: "decision" as const, label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Break and Retest", next: "br-path" }, { label: "Fibonacci", next: "fib-path" }], scope: emptyScope() },
        { id: "br-path", type: "action" as const, label: "Break and Retest entry", description: null, next: [], branches: [], scope: emptyScope() },
        { id: "fib-path", type: "action" as const, label: "Fibonacci entry (daily/weekly)", description: null, next: [], branches: [], scope: emptyScope() },
      ],
      readableSteps: [],
      scopeLeaks: [],
    };

    const leaks = findGlobalGateScopeLeaks(badDecisionFramework as never);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].nodeId).toBe("session-gate");
    expect(leaks[0].scope.sessions).toEqual(["market-open"]);
  });

  it("findGlobalGateScopeLeaks does NOT flag a scoped node correctly placed behind a strategy-selection branch (daily/weekly Fibonacci and swing Inside Bar are not blocked)", async () => {
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const goodDecisionFramework = {
      nodes: [
        { id: "start", type: "start" as const, label: "Start", description: null, next: ["pick-strategy"], branches: [], scope: emptyScope() },
        {
          id: "pick-strategy",
          type: "decision" as const,
          label: "Which canonical strategy applies?",
          description: null,
          next: [],
          branches: [
            { label: "Break and Retest (intraday, options)", next: "br-session-check" },
            { label: "Fibonacci (daily/weekly)", next: "fib-path" },
            { label: "Inside Bar (swing)", next: "inside-bar-path" },
          ],
          scope: emptyScope(),
        },
        {
          // Correctly conditional: only reachable AFTER "Break and Retest" is already selected via a branch.
          id: "br-session-check",
          type: "action" as const,
          label: "Trade only 9:30-11:00 AM ET",
          description: null,
          next: [],
          branches: [],
          scope: emptyScope({ marketsOrInstruments: ["options"], sessions: ["market-open"] }),
        },
        { id: "fib-path", type: "action" as const, label: "Fibonacci entry — no session restriction", description: null, next: [], branches: [], scope: emptyScope() },
        {
          id: "inside-bar-path",
          type: "action" as const,
          label: "Inside Bar resting stop-order entry (swing, not 1-minute)",
          description: null,
          next: [],
          branches: [],
          scope: emptyScope(),
        },
      ],
      readableSteps: [],
      scopeLeaks: [],
    };

    const leaks = findGlobalGateScopeLeaks(goodDecisionFramework as never);
    expect(leaks).toEqual([]);
  });

  it("scalingInRules/scalingOutRules/runnerManagementRules preserve scope when fed to the decision-framework prompt — options/equities scaling never presented as mandatory for every strategy", async () => {
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });
    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");

    const canonicalStrategy = {
      name: "Break and Retest",
      purpose: "p",
      markets: [],
      timeframes: [],
      marketContext: [], prerequisites: [], setup: [], entryRules: [], confirmationRules: [], stopLossRules: [],
      profitTargetRules: [], tradeManagementRules: [], invalidationRules: [], noTradeConditions: [], visualDiscretionaryRules: [],
      riskManagementRules: [], positionSizingRules: [],
      scalingOutRules: [
        {
          description: "Scale 50-80% at target 1, keep a 10-20% runner.",
          classification: "explicit" as const,
          supportLevel: "SINGLE_SOURCE" as const,
          supportCount: 1,
          sources: [],
          conflictSources: [],
          exceptions: [],
          numericalValues: [],
          scope: { strategies: ["Break and Retest"], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] },
        },
      ],
      scalingInRules: [], runnerManagementRules: [], warnings: [], instructorPreferences: [],
      variants: [], examples: [], ambiguities: [], conflicts: [], sourceLessonIds: [], supportingKnowledgeLessonIds: [],
    };

    await synthesizeDecisionFramework({ gemini, model: "m" }, [canonicalStrategy as never], { sections: [] } as never);

    expect(capturedPrompt).toContain("Scale 50-80% at target 1");
    // The scaling rule's scope (options-only, this-strategy-only) must survive into the prompt, not be stripped to a bare description.
    expect(capturedPrompt).toContain('"marketsOrInstruments"');
    expect(capturedPrompt).toContain("options");
  });
});

describe("Real-audit Blocker 6 — no false-universal retest rule in the playbook", () => {
  function fullCanonicalStrategy(overrides: Record<string, unknown>) {
    return {
      name: "Strategy",
      purpose: "p",
      markets: [],
      timeframes: [],
      marketContext: [], prerequisites: [], setup: [], entryRules: [], confirmationRules: [], stopLossRules: [],
      profitTargetRules: [], tradeManagementRules: [], invalidationRules: [], noTradeConditions: [], visualDiscretionaryRules: [],
      riskManagementRules: [], positionSizingRules: [], scalingInRules: [], scalingOutRules: [], runnerManagementRules: [],
      warnings: [], instructorPreferences: [], variants: [], examples: [], ambiguities: [], conflicts: [],
      sourceLessonIds: [], supportingKnowledgeLessonIds: [],
      ...overrides,
    };
  }

  it("the playbook prompt instructs against false-universal claims AND still shows Inside Bar's conflicting resting-stop entry rule (the exact real-audit conflict)", async () => {
    const { synthesizePlaybook } = await import("../src/synthesis/playbook.js");
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
      }),
    });

    const breakAndRetest = fullCanonicalStrategy({
      name: "Break and Retest",
      entryRules: [
        { description: "Never chase the initial breakout candle — enter only on the pullback/retest.", classification: "explicit", supportLevel: "REPEATED_EXPLICIT", supportCount: 5, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null },
      ],
    });
    const insideBar = fullCanonicalStrategy({
      name: "Inside Bar",
      entryRules: [
        { description: "May enter via a resting buy-stop above the mother-bar high (or sell-stop below the mother-bar low) — does not require waiting for a retest.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null },
      ],
    });

    await synthesizePlaybook({ gemini, model: "m" }, "Trading Accelerator", [breakAndRetest as never, insideBar as never], { sections: [] });

    // The instruction that prevents the false-universal claim must actually be present in what Gemini sees.
    expect(capturedPrompt).toContain("do not state a rule as universal");
    expect(capturedPrompt).toContain("resting stop-order entry");

    // The conflicting evidence itself (Inside Bar's resting-stop variant) must reach the prompt — the guard is useless if the model never sees the counter-example.
    expect(capturedPrompt).toContain("resting buy-stop above the mother-bar high");
    expect(capturedPrompt).toContain("Never chase the initial breakout candle");
  });
});

describe("Real-audit Blocker 7 — unmatched strategy-scope aliasing review", () => {
  it("matches 'Premarket Break and Retest' to the Break and Retest (B&R) cluster via token-subset matching, even though pure substring containment fails due to the '(B&R)' suffix", async () => {
    const { deterministicMapScopeNames } = await import("../src/synthesis/strategyScopeMapping.js");
    const clusters = [
      { clusterKey: "br", proposedCanonicalName: "Break and Retest (B&R) with Key Levels and Order Blocks", memberNames: ["Break & Retest"] },
    ];
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["Premarket Break and Retest"], clusters);
    expect(mapped.get("Premarket Break and Retest")).toBe("br");
    expect(unmatchedNames).toEqual([]);
  });

  it("does NOT force-map genuinely unrelated names (Straddle, swing trading, Scalping, 84% Rule, momentum trading) to an unrelated cluster", async () => {
    const { deterministicMapScopeNames } = await import("../src/synthesis/strategyScopeMapping.js");
    const clusters = [
      { clusterKey: "br", proposedCanonicalName: "Break and Retest (B&R)", memberNames: ["Break & Retest"] },
      { clusterKey: "ob", proposedCanonicalName: "Intraday Order Block Continuation", memberNames: ["Order Block Retest"] },
    ];
    const names = ["Straddle", "swing trading", "Scalping", "84% Rule", "momentum trading"];
    const { mapped, unmatchedNames } = deterministicMapScopeNames(names, clusters);
    expect(mapped.size).toBe(0);
    expect(unmatchedNames.sort()).toEqual([...names].sort());
  });

  it("leaves a name unmatched when it covers none of any cluster's identifying tokens, rather than guessing", async () => {
    const { deterministicMapScopeNames } = await import("../src/synthesis/strategyScopeMapping.js");
    const clusters = [
      { clusterKey: "br", proposedCanonicalName: "Break and Retest", memberNames: [] },
      { clusterKey: "ob", proposedCanonicalName: "Order Block Retest", memberNames: [] },
    ];
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["Reversal"], clusters);
    expect(mapped.size).toBe(0);
    expect(unmatchedNames).toEqual(["Reversal"]);
  });

  it("leaves a name unmatched when it fully covers TWO different clusters' identifying tokens at once — genuine ambiguity, never guessed", async () => {
    const { deterministicMapScopeNames } = await import("../src/synthesis/strategyScopeMapping.js");
    const clusters = [
      { clusterKey: "a", proposedCanonicalName: "Order Block Continuation", memberNames: [] },
      { clusterKey: "b", proposedCanonicalName: "Continuation Retest", memberNames: [] },
    ];
    // Word order deliberately differs from both candidate names, so Pass 1's substring containment matches NEITHER — only
    // the order-independent token-subset check (Pass 2) would fire, and it fires for BOTH clusters at once: ambiguous.
    const { mapped, unmatchedNames } = deterministicMapScopeNames(["Continuation Block Order Retest"], clusters);
    expect(mapped.size).toBe(0);
    expect(unmatchedNames).toEqual(["Continuation Block Order Retest"]);
  });

  it("still resolves a genuinely ambiguous name via the Gemini fallback tier rather than leaving it unmatched forever", async () => {
    const { resolveStrategyScopeNames } = await import("../src/synthesis/strategyScopeMapping.js");
    const clusters = [
      { clusterKey: "br", proposedCanonicalName: "Break and Retest", memberNames: [] },
      { clusterKey: "pmh", proposedCanonicalName: "Pre-Market High and Low Strategy", memberNames: [] },
    ];
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({ mappings: [{ rawName: "Premarket Reversal", clusterKey: "pmh" }] }),
        usage,
      })),
    });
    const { result } = await resolveStrategyScopeNames({ gemini, model: "m" }, ["Premarket Reversal"], clusters);
    expect(result.mapped.get("Premarket Reversal")).toBe("pmh");
  });
});
