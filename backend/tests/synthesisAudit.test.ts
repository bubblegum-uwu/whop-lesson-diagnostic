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
                { key: "course_philosophy", title: "Philosophy", content: "p", sourceKeys: [] },
                { key: "pre_market_preparation", title: "Prep", content: "p", sourceKeys: [] },
                { key: "higher_timeframe_framework", title: "HTF", content: "p", sourceKeys: [] },
                { key: "market_context_regime", title: "Regime", content: "p", sourceKeys: [] },
                { key: "key_levels", title: "Levels", content: "p", sourceKeys: [] },
                { key: "setup_selection", title: "Setup", content: "The playbook recognizes fifteen canonical strategies.", sourceKeys: [] },
                { key: "entry_framework", title: "Entry", content: "e", sourceKeys: [] },
                { key: "confirmation_framework", title: "Confirmation", content: "c", sourceKeys: [] },
                { key: "risk_management", title: "Risk", content: "r", sourceKeys: [] },
                { key: "stop_placement", title: "Stops", content: "s", sourceKeys: [] },
                { key: "target_selection", title: "Targets", content: "t", sourceKeys: [] },
                { key: "trade_management", title: "Management", content: "m", sourceKeys: [] },
                { key: "no_trade_conditions", title: "No Trade", content: "n", sourceKeys: [] },
                { key: "strategy_variants", title: "Variants", content: "v", sourceKeys: [] },
                { key: "common_mistakes_warnings", title: "Warnings", content: "w", sourceKeys: [] },
                { key: "conflicts_and_ambiguities", title: "Conflicts", content: "c", sourceKeys: [] },
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

    expect(capturedPrompt).toContain("GENUINELY GLOBAL rules");
    expect(capturedPrompt).toContain("SCOPED rules");
    expect(capturedPrompt).toContain("Always define risk before entry.");
    expect(capturedPrompt).toContain("Trade only 9:30-11:00 AM ET.");
    expect(capturedPrompt).toContain("9:30-11:00 AM");
    // The scoped rule's own scope object must actually appear in the SCOPED pool text (not stripped out as a bare string).
    expect(capturedPrompt).toContain('"marketsOrInstruments"');

    // Split the prompt at the SCOPED-pool marker: the global-only rule must appear before it, the scoped rule's restriction detail must appear after it.
    const scopedPoolIndex = capturedPrompt.indexOf("SCOPED rules");
    const globalRuleIndex = capturedPrompt.indexOf("Always define risk before entry.");
    expect(globalRuleIndex).toBeLessThan(scopedPoolIndex);
  });

  it("findGlobalGateScopeLeaks flags a node whose CITED sources derive a scoped `scope`, placed on the unconditional path before strategy selection (the exact real-audit failure, v3: scope is now always derived from sourceKeys, never self-reported)", async () => {
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const badDecisionFramework = {
      nodes: [
        { id: "start", type: "start" as const, label: "Start", description: null, next: ["session-gate"], branches: [], sourceKeys: [], scope: emptyScope() },
        {
          // The exact real-audit failure: a 9:30-11am/options/1m-5m-scoped rule placed as an UNCONDITIONAL gate.
          // sourceKeys/scope here represent what decisionFramework.ts's enrichNode would have DERIVED from the cited
          // scoped source — never self-reported, so this can only happen when the node is honestly built from scoped material.
          id: "session-gate",
          type: "action" as const,
          label: "Trending & Normal Session (9:30 - 11:00 AM EST...)",
          description: null,
          next: ["pick-strategy"],
          branches: [],
          sourceKeys: ["k1"],
          scope: emptyScope({ marketsOrInstruments: ["options"], timeframes: ["1m", "5m"], sessions: ["market-open"] }),
        },
        { id: "pick-strategy", type: "decision" as const, label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Break and Retest", next: "br-path" }, { label: "Fibonacci", next: "fib-path" }], sourceKeys: [], scope: emptyScope() },
        { id: "br-path", type: "action" as const, label: "Break and Retest entry", description: null, next: [], branches: [], sourceKeys: ["k2"], scope: emptyScope() },
        { id: "fib-path", type: "action" as const, label: "Fibonacci entry (daily/weekly)", description: null, next: [], branches: [], sourceKeys: ["k3"], scope: emptyScope() },
      ],
      readableSteps: [],
      scopeLeaks: [],
    };

    const leaks = findGlobalGateScopeLeaks(badDecisionFramework as never);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].nodeId).toBe("session-gate");
    expect(leaks[0].reason).toBe("scoped_source");
    expect(leaks[0].scope.sessions).toEqual(["market-open"]);
  });

  it("findGlobalGateScopeLeaks does NOT flag a scoped node correctly placed behind a strategy-selection branch (daily/weekly Fibonacci and swing Inside Bar are not blocked)", async () => {
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const goodDecisionFramework = {
      nodes: [
        { id: "start", type: "start" as const, label: "Start", description: null, next: ["pick-strategy"], branches: [], sourceKeys: [], scope: emptyScope() },
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
          sourceKeys: [],
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
          sourceKeys: ["k1"],
          scope: emptyScope({ marketsOrInstruments: ["options"], sessions: ["market-open"] }),
        },
        { id: "fib-path", type: "action" as const, label: "Fibonacci entry — no session restriction", description: null, next: [], branches: [], sourceKeys: ["k2"], scope: emptyScope() },
        {
          id: "inside-bar-path",
          type: "action" as const,
          label: "Inside Bar resting stop-order entry (swing, not 1-minute)",
          description: null,
          next: [],
          branches: [],
          sourceKeys: ["k3"],
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

/**
 * SECOND real-data audit regression tests (Phase 3.5B v3) — see PR #13's
 * second real 28-lesson dry-run audit. Blockers A/C are architectural: a
 * decision node's `scope` is no longer ever self-reported by Gemini — it is
 * derived deterministically from `sourceKeys`, the pooled rule(s) the node
 * actually cites (see decisionFramework.ts). Blocker B restricts what
 * Gemini is shown when writing "master_trading_checklist" to genuinely
 * global material only (see playbook.ts), with a deterministic secondary
 * vocabulary check (universalSectionAudit.ts) as a safety net. Blocker D is
 * the resulting strengthened decisionScopeAudit.ts, exercised throughout.
 */
function fullCanonicalStrategyV3(overrides: Record<string, unknown>) {
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

describe("Real-audit Blocker A — decision-node scope is derived from cited sources, never self-reported (fixes the 'Is Stock In Play?' false negative)", () => {
  it("citing a stock-scoped source rule derives a non-empty scope for the node — a stock/equity-specific gate can never surface as global just because Gemini emits empty scope arrays", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["stock-in-play-gate"], branches: [], sourceKeys: [] },
            {
              id: "stock-in-play-gate",
              type: "action",
              label: "Is Stock In Play & Criteria Satisfied?",
              description: "Verify that the asset is 'In Play' with clear levels, volume expansion, or fundamental catalysts.",
              next: ["pick-strategy"],
              branches: [],
              sourceKeys: ["k1"],
            },
            { id: "pick-strategy", type: "decision", label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Momentum Stock Breakout", next: "end" }], sourceKeys: [] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Check In Play", "Pick strategy"],
        }),
        usage,
      })),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const momentumStock = fullCanonicalStrategyV3({
      name: "Momentum Stock Breakout",
      setup: [
        {
          description: "Verify that the asset is 'In Play' with clear levels, volume expansion, or fundamental catalysts.",
          classification: "explicit",
          supportLevel: "SINGLE_SOURCE",
          supportCount: 1,
          sources: [],
          conflictSources: [],
          exceptions: [],
          numericalValues: [],
          scope: { strategies: [], marketsOrInstruments: ["stocks"], timeframes: [], sessions: [], traderProfiles: [] },
        },
      ],
    });

    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [momentumStock as never], { sections: [] } as never);

    const gateNode = decisionFramework.nodes.find((n) => n.id === "stock-in-play-gate")!;
    // Gemini cited k1 but never claimed a scope itself — this is 100% code-derived from that citation's own already-known scope.
    expect(gateNode.scope.marketsOrInstruments).toEqual(["stocks"]);
    expect(decisionFramework.scopeLeaks).toHaveLength(1);
    expect(decisionFramework.scopeLeaks[0]).toMatchObject({ nodeId: "stock-in-play-gate", reason: "scoped_source" });
  });

  it("a citation-less ('ungrounded') pre-strategy gate is flagged even though its derived scope is empty — closes the exact v2 false negative where a self-reported empty scope was silently trusted as global", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["stock-in-play-gate"], branches: [], sourceKeys: [] },
            {
              // No sourceKeys at all — exactly the real-audit failure: an unconditional gate with nothing backing it.
              id: "stock-in-play-gate",
              type: "action",
              label: "Is Stock In Play & Criteria Satisfied?",
              description: "Verify that the asset is 'In Play' with clear levels, volume expansion, or fundamental catalysts.",
              next: ["pick-strategy"],
              branches: [],
              sourceKeys: [],
            },
            { id: "pick-strategy", type: "decision", label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Futures Trend Continuation", next: "end" }], sourceKeys: [] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Check In Play", "Pick strategy"],
        }),
        usage,
      })),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const futures = fullCanonicalStrategyV3({ name: "Futures Trend Continuation" });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [futures as never], { sections: [] } as never);

    const gateNode = decisionFramework.nodes.find((n) => n.id === "stock-in-play-gate")!;
    expect(gateNode.scope).toEqual(emptyScope()); // v2 would have silently trusted this self-reported-empty scope as global
    expect(decisionFramework.scopeLeaks).toHaveLength(1);
    expect(decisionFramework.scopeLeaks[0]).toMatchObject({ nodeId: "stock-in-play-gate", reason: "ungrounded" });
  });

  it("a genuinely global rule may remain global — a node citing a truly empty-scope source is never flagged", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["risk-gate"], branches: [], sourceKeys: [] },
            { id: "risk-gate", type: "action", label: "Always define risk before entry", description: null, next: ["pick-strategy"], branches: [], sourceKeys: ["k1"] },
            { id: "pick-strategy", type: "decision", label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Strategy", next: "end" }], sourceKeys: [] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Define risk", "Pick strategy"],
        }),
        usage,
      })),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const coreFramework = {
      sections: [
        {
          key: "risk",
          title: "Risk",
          rules: [{ description: "Always define risk before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null }],
        },
      ],
    };
    const strategy = fullCanonicalStrategyV3({ name: "Strategy" });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [strategy as never], coreFramework as never);

    const riskNode = decisionFramework.nodes.find((n) => n.id === "risk-gate")!;
    expect(riskNode.scope).toEqual(emptyScope());
    expect(decisionFramework.scopeLeaks).toEqual([]);
  });

  it("a futures strategy and a forex strategy each reach strategy selection without satisfying a stock-specific 'In Play'/mega-cap gate, which is correctly placed only behind the stock strategy's own branch", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["pick-strategy"], branches: [], sourceKeys: [] },
            {
              id: "pick-strategy",
              type: "decision",
              label: "Which canonical strategy applies?",
              description: null,
              next: [],
              branches: [
                { label: "Momentum Stock Breakout", next: "stock-in-play-gate" },
                { label: "Futures Trend Continuation", next: "futures-path" },
                { label: "Forex Session Breakout", next: "forex-path" },
              ],
              sourceKeys: [],
            },
            { id: "stock-in-play-gate", type: "action", label: "Is Stock In Play & Criteria Satisfied?", description: null, next: ["stock-path"], branches: [], sourceKeys: ["k1"] },
            { id: "stock-path", type: "action", label: "Momentum Stock Breakout entry", description: null, next: [], branches: [], sourceKeys: [] },
            { id: "futures-path", type: "action", label: "Futures Trend Continuation entry", description: null, next: [], branches: [], sourceKeys: [] },
            { id: "forex-path", type: "action", label: "Forex Session Breakout entry", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Pick strategy", "Stock: check In Play", "Futures/Forex: enter directly"],
        }),
        usage,
      })),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const momentumStock = fullCanonicalStrategyV3({
      name: "Momentum Stock Breakout",
      setup: [
        {
          description: "Verify In Play.",
          classification: "explicit",
          supportLevel: "SINGLE_SOURCE",
          supportCount: 1,
          sources: [],
          conflictSources: [],
          exceptions: [],
          numericalValues: [],
          scope: { strategies: [], marketsOrInstruments: ["stocks"], timeframes: [], sessions: [], traderProfiles: [] },
        },
      ],
    });
    const futures = fullCanonicalStrategyV3({ name: "Futures Trend Continuation" });
    const forex = fullCanonicalStrategyV3({ name: "Forex Session Breakout" });

    const { decisionFramework } = await synthesizeDecisionFramework(
      { gemini, model: "m" },
      [momentumStock as never, futures as never, forex as never],
      { sections: [] } as never,
    );

    // The stock-only gate sits BEHIND the "Momentum Stock Breakout" branch — never on the
    // unconditional spine reachable before strategy selection — so nothing is flagged.
    expect(decisionFramework.scopeLeaks).toEqual([]);

    const byId = new Map(decisionFramework.nodes.map((n) => [n.id, n]));
    // Futures/forex paths are reachable directly from their own branch — never routed through stock-in-play-gate.
    expect(byId.get("futures-path")).toBeDefined();
    expect(byId.get("forex-path")).toBeDefined();
    expect(byId.get("stock-in-play-gate")!.scope.marketsOrInstruments).toEqual(["stocks"]);
  });
});

describe("Real-audit Blocker C — a decision node's applicability can never disagree with (or be broader than) the structured rule(s) it was synthesized from", () => {
  it("citing CoreFramework's options/beginner-scoped 2R rule derives that SAME scope on the decision node — it can never surface as an empty-scope universal 'minimum 2R target' node", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["two-r-gate"], branches: [], sourceKeys: [] },
            { id: "two-r-gate", type: "action", label: "Target a minimum 2R", description: null, next: ["end"], branches: [], sourceKeys: ["k1"] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Target 2R"],
        }),
        usage,
      })),
    });

    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const twoRScope = { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] };
    const coreFramework = {
      sections: [
        {
          key: "risk",
          title: "Risk",
          rules: [
            {
              description: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.",
              classification: "explicit",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sources: [],
              conflictSources: [],
              exceptions: [],
              numericalValues: [],
              scope: twoRScope,
            },
          ],
        },
      ],
    };
    const strategy = fullCanonicalStrategyV3({ name: "Strategy" });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [strategy as never], coreFramework as never);

    const twoRNode = decisionFramework.nodes.find((n) => n.id === "two-r-gate")!;
    // The node's scope is EXACTLY the cited rule's own scope — never broader, never emptied out.
    expect(twoRNode.scope).toEqual(twoRScope);
    // Being genuinely scoped (options/beginner), it must still be caught if it sits on the unconditional pre-strategy spine.
    expect(decisionFramework.scopeLeaks).toHaveLength(1);
    expect(decisionFramework.scopeLeaks[0]).toMatchObject({ nodeId: "two-r-gate", reason: "scoped_source" });
  });

  it("a node citing BOTH a genuinely global rule and a scoped rule derives the UNION of their scopes — it is never treated as an unconditional global gate merely because one of its sources was global", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["combined-gate"], branches: [], sourceKeys: [] },
            { id: "combined-gate", type: "action", label: "Define risk; beginners size down", description: null, next: ["end"], branches: [], sourceKeys: ["k1", "k2"] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Define risk"],
        }),
        usage,
      })),
    });
    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const coreFramework = {
      sections: [
        {
          key: "risk",
          title: "Risk",
          rules: [
            { description: "Always define risk before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null },
            {
              description: "Beginners should size positions smaller.",
              classification: "explicit",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sources: [],
              conflictSources: [],
              exceptions: [],
              numericalValues: [],
              scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: ["beginner"] },
            },
          ],
        },
      ],
    };
    const strategy = fullCanonicalStrategyV3({ name: "Strategy" });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [strategy as never], coreFramework as never);

    const combinedNode = decisionFramework.nodes.find((n) => n.id === "combined-gate")!;
    // Citing a global (k1) and a scoped (k2) source at once yields the UNION — the scoped restriction is never diluted away by the global citation.
    expect(combinedNode.scope.traderProfiles).toEqual(["beginner"]);
    expect(decisionFramework.scopeLeaks).toHaveLength(1);
    expect(decisionFramework.scopeLeaks[0]).toMatchObject({ nodeId: "combined-gate", reason: "scoped_source" });
  });
});

describe("Real-audit v5, Blocker 2 — 'master_trading_checklist' is built deterministically from ONLY VERIFIED_GLOBAL CoreFramework rules, never asked of Gemini", () => {
  it("synthesizePlaybook no longer produces (or is even asked to produce) a 'master_trading_checklist' section", async () => {
    const { synthesizePlaybook } = await import("../src/synthesis/playbook.js");
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
      }),
    });
    const strategy = fullCanonicalStrategyV3({ name: "Strategy" });
    await synthesizePlaybook({ gemini, model: "m" }, "Trading Accelerator", [strategy as never], { sections: [] } as never);

    const keysListMatch = /using these keys: ([^.]+)\./.exec(capturedPrompt);
    expect(keysListMatch).not.toBeNull();
    const requiredKeys = keysListMatch![1].split(",").map((k) => k.trim());
    expect(requiredKeys).not.toContain("master_trading_checklist");
    expect(capturedPrompt).toContain("never written by you");
  });

  it("runSynthesis builds master_trading_checklist deterministically from ONLY VERIFIED_GLOBAL CoreFramework rules — a scoped rule's text never appears in it, even if Gemini tries to write one anyway", async () => {
    const clusterJson = JSON.stringify({
      clusters: [{ clusterKey: "s1", proposedCanonicalName: "Strategy", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }],
    });
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) return { text: clusterJson, usage };
        if (prompt.includes("synthesizing ONE canonical trading strategy")) return { text: rawCanonicalStrategyJson("Strategy"), usage };
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "risk",
                  title: "Risk",
                  rules: [
                    { description: "Always define risk on every trade before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sourceKeys: ["k1"], conflictSourceKeys: [] },
                    { description: "Trade only during market-open with options.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k2"], conflictSourceKeys: [] },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        if (prompt.includes("Comprehensive Trading Playbook")) {
          // Even if Gemini disobeys and tries to write a "master_trading_checklist" section anyway
          // (should not happen given the prompt, but never trusted), it is simply not spliced in —
          // the deterministic one from runSynthesis.ts always wins at that key.
          return {
            text: JSON.stringify({
              title: "Playbook",
              sections: [{ key: "master_trading_checklist", title: "Rogue Checklist", content: "Trade options during market-open, always.", sourceKeys: [] }],
              conflictsAndAmbiguities: [],
            }),
            usage,
          };
        }
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          // k1 (global, pooled first) backs "Always define risk on every trade before entry." (positive-proof language); k2 (scoped) backs the market-open/options rule.
          knowledgeItems: [
            makeKnowledgeItem({ statement: "Always define risk on every trade before entry.", scope: emptyScope() }),
            makeKnowledgeItem({ statement: "Trade only during market-open with options.", scope: emptyScope({ marketsOrInstruments: ["options"], sessions: ["market-open"] }) }),
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const input: RunSynthesisInput = {
      courseTitle: "Trading Accelerator",
      instances: [makeInstance()],
      lessons: [{ id: 10, title: "Lesson 10", chapterTitle: null, sourceUrl: "https://x" }],
      noStandaloneSetupLessonIds: [],
      knowledgeSources,
    };
    const result = await runSynthesis({ gemini, model: "m" }, input);

    const checklistSections = result.playbook.sections.filter((s) => s.key === "master_trading_checklist");
    expect(checklistSections).toHaveLength(1); // Gemini's rogue attempt is never spliced in alongside the real one.
    const checklist = checklistSections[0];
    expect(checklist.applicabilityPolicy).toBe("VERIFIED_GLOBAL_ONLY");
    expect(checklist.content).toContain("Always define risk on every trade before entry.");
    expect(checklist.content).not.toContain("market-open");
    expect(checklist.content).not.toContain("Rogue Checklist");
    expect(checklist.content).not.toContain("options");
  });

  it("assertMasterChecklistSourcesGlobal (the synthesis invariant) throws SynthesisInvariantError if a SCOPED or UNVERIFIED rule were ever selected — fails the build rather than merely warning (real-audit requirement)", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const { SynthesisInvariantError } = await import("../src/synthesis/errors.js");

    const scopedRule = {
      description: "options-only",
      classification: "explicit" as const,
      supportLevel: "SINGLE_SOURCE" as const,
      supportCount: 1,
      sources: [],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] },
      scopeBasis: "SCOPED" as const,
    };
    const unverifiedRule = { ...scopedRule, description: "legacy", scope: null, scopeBasis: "UNVERIFIED" as const };
    // v8: description carries explicit positive universal language ("every trade") so this well-formed rule satisfies the positive-proof requirement too.
    const verifiedGlobalRule = { ...scopedRule, description: "This genuinely global principle applies to every trade you take.", scope: null, scopeBasis: "VERIFIED_GLOBAL" as const };

    expect(() => assertMasterChecklistSourcesGlobal([verifiedGlobalRule])).not.toThrow();
    expect(() => assertMasterChecklistSourcesGlobal([verifiedGlobalRule, scopedRule])).toThrow(SynthesisInvariantError);
    expect(() => assertMasterChecklistSourcesGlobal([unverifiedRule])).toThrow(SynthesisInvariantError);
  });
});

describe("Real-audit v5, Blocker 2 — playbookApplicabilityAudit.ts: policy-aware categorized leaks replace the single universalSectionScopeLeaks gate", () => {
  it("SCOPED policy (scoped_execution_checklists): options/1m/9:30 material with EXPLICIT applicability stated is NOT flagged", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const scope = { strategies: [], marketsOrInstruments: ["options"], timeframes: ["1m"], sessions: ["market-open"], traderProfiles: [] };
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "scoped_execution_checklists",
          content: "Intraday Equities/Options Checklist (1-minute, market-open session only): every step below applies ONLY to intraday options trades during the market-open session on the 1-minute chart.",
          scope,
          scopeBasis: "SCOPED",
          applicabilityPolicy: "SCOPED",
        },
      ],
      new Set(["options", "1m", "market-open"]),
    );
    expect(result.scopedApplicabilityLeaks).toEqual([]);
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("SCOPED policy: absolute-claim language in a section that NEVER states its own declared scope anywhere IS an applicability leak (broadening beyond declared scope)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const scope = { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] };
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "scoped_execution_checklists",
          // The section's own declared scope ("options") is never mentioned anywhere in the
          // content — genuine broadening, not a same-sentence-co-occurrence false positive.
          content: "Always scale out 50% at target 1 on every trade you take.",
          scope,
          scopeBasis: "SCOPED",
          applicabilityPolicy: "SCOPED",
        },
      ],
      new Set(["options"]),
    );
    expect(result.scopedApplicabilityLeaks).toHaveLength(1);
    expect(result.scopedApplicabilityLeaks[0].sectionKey).toBe("scoped_execution_checklists");
  });

  it("real-audit fix (v6): a multi-sub-checklist SCOPED section that states each sub-checklist's applicability in a DIFFERENT sentence than its absolute-claim language is NOT flagged (the exact scoped_execution_checklists false positive — matchedNonGlobalRules was [] because this is a pure same-sentence heuristic, not real evidence of broadening)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const scope = { strategies: [], marketsOrInstruments: ["options", "futures"], timeframes: ["1m"], sessions: ["market-open"], traderProfiles: [] };
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "scoped_execution_checklists",
          content:
            "Intraday Options Checklist. This sub-checklist applies to options day trading during the market-open session. Always confirm the setup before entry. Every step below scales out at the first target. " +
            "Futures Checklist. This sub-checklist applies to futures on the 1-minute chart. Always wait for candle close before entry.",
          scope,
          scopeBasis: "SCOPED",
          applicabilityPolicy: "SCOPED",
        },
      ],
      new Set(["options", "futures", "1m", "market-open"]),
    );
    expect(result.scopedApplicabilityLeaks).toEqual([]);
  });

  it("CONFLICT_DOCUMENTATION policy (conflicts_and_ambiguities): mentioning/quoting conflicting SCOPED rules side by side is NEVER flagged", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "conflicts_and_ambiguities",
          content: "One options-only lesson states every beginner must always wait for a 5-minute close, while a different futures lesson states every trader must always enter on the 1-minute close — these directly conflict.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: ["5m"], sessions: [], traderProfiles: ["beginner"] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "CONFLICT_DOCUMENTATION",
        },
      ],
      new Set(["options", "5m", "beginner"]),
      [{ description: "Always wait for a 5-minute close.", basis: "SCOPED" }],
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
    expect(result.scopedApplicabilityLeaks).toEqual([]);
  });

  it("VERIFIED_GLOBAL_ONLY policy (master_trading_checklist): exempt from all checks by policy — universal prose is expected and allowed", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "master_trading_checklist",
          content: "Always define risk before entry — this applies to every strategy, every instrument, every session, without exception.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "VERIFIED_GLOBAL",
          applicabilityPolicy: "VERIFIED_GLOBAL_ONLY",
        },
      ],
      new Set(),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
    expect(result.scopedApplicabilityLeaks).toEqual([]);
  });

  it("real-audit fix (v9): DESCRIPTIVE_MIXED policy (e.g. risk_management) — a section is NOT flagged merely because its own derived scopeBasis is SCOPED, with no actual matched non-global rule (aggregate ownBasis alone is no longer an independent trigger — see v9's top doc comment)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "risk_management",
          content: "The system enforces a minimum reward-to-risk ratio on every planned execution.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(), // no matching nonGlobalRules passed — nothing for the sentence to actually overlap
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("DESCRIPTIVE_MIXED policy: a section is flagged as an unverifiedUniversalClaim when a specific absolute-claim sentence closely matches a known UNVERIFIED rule and states no local qualifier", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Confirm Intraday Fundamentals and QQQ/SPY relative strength before entering.", basis: "UNVERIFIED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "market_context_regime",
          content: "Always confirm Intraday Fundamentals and QQQ/SPY relative strength before every trade.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.unverifiedUniversalClaims).toHaveLength(1);
    expect(result.unverifiedUniversalClaims[0].sectionKey).toBe("market_context_regime");
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });

  it("real-audit fix (v9): DESCRIPTIVE_MIXED policy — a section is NOT flagged merely because its own derived scopeBasis is UNVERIFIED, with no actual matched non-global rule", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "market_context_regime",
          content: "Always confirm Intraday Fundamentals and QQQ/SPY relative strength before every trade.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
    );
    expect(result.unverifiedUniversalClaims).toEqual([]);
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });

  it("DESCRIPTIVE_MIXED policy: still catches a leak via word-overlap with a known non-global rule even when the section's own citations are empty/VERIFIED_GLOBAL (secondary lexical safeguard)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "risk_management",
          content: "The system enforces a minimum reward-to-risk ratio of at least 2:1 on every planned execution.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "VERIFIED_GLOBAL", // this section's OWN citations are (incorrectly) all global — the lexical check is what catches it
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(), // no literal vocabulary term repeated
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });

  it("DESCRIPTIVE_MIXED policy: no absolute-claim language at all -> never flagged, regardless of scopeBasis", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "strategy_variants",
          content: "For options traders, this variant scales out differently.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["options"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });

  it("real-audit fix (v6): DESCRIPTIVE_MIXED strategy_variants is NOT flagged merely for having ownBasis SCOPED when its prose explicitly attributes the scoped mechanics to their named parent strategy, even with absolute-claim language present", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "strategy_variants",
          content: "For the Inside Bar strategy, always wait for candle close before entry — this mechanic belongs only to the Inside Bar strategy and is not a general rule.",
          scope: { strategies: ["Inside Bar"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(), // deliberately empty — proves this section isn't merely surviving via an empty vocabulary set
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real-audit fix (v9), do-not-weaken check: DESCRIPTIVE_MIXED strategy_variants with a specific sentence that does NOT name its own declared scope and closely matches a known SCOPED rule IS still flagged", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Wait for candle close before entry on every trade.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "strategy_variants",
          content: "Always wait for candle close before entry on every trade.",
          scope: { strategies: ["Inside Bar"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].sectionKey).toBe("strategy_variants");
  });

  it("real-audit fix (v9), do-not-weaken check: a strategy_variants section naming its OWN parent strategy in one sentence is still flagged when a SEPARATE sentence overlaps a DIFFERENT, undisclosed non-global rule's text without stating its own applicability (matchedScopedRules stays fully sensitive per-sentence — local qualification only defeats the leak for the sentence it actually appears in)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Wait for the 84% re-entry confirmation before adding to a runner position.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "strategy_variants",
          content: "This mechanic belongs specifically to the Inside Bar strategy. Always wait for the 84% re-entry confirmation before adding to a runner position on every trade.",
          scope: { strategies: ["Inside Bar"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });
});

/**
 * SIXTH real-data audit regression tests (Phase 3.5B v7, corrected in
 * v8/v9) — see PR #13's sixth real 28-lesson dry-run audit. Four
 * DESCRIPTIVE_MIXED sections (key_levels, setup_selection,
 * risk_management, target_selection) were false-positive-flagged for the
 * same underlying reason: each mixes a genuinely VERIFIED_GLOBAL rule with
 * properly-qualified SCOPED material, and combineScopeBasis's "SCOPED
 * dominates" priority (correct for the union `scope` itself) made the
 * section's AGGREGATE `scopeBasis` read "SCOPED" even though the specific
 * absolute claim in question is independently globally backed.
 *
 * v7's fix (a section-level `hasIndependentGlobalEvidence` flag) caused a
 * real false NEGATIVE (market_context_regime, see the v8/v9 describe block
 * below). v8 replaced it with sentence-level matching against a
 * `globalRules` pool; v9 found THAT could also suppress a real leak (a
 * sentence mixing an erased restriction with genuinely global wording) and
 * removed it entirely (see playbookApplicabilityAudit.ts's top doc
 * comment) — as of v9, mechanism A only ever flags a sentence when it
 * ACTUALLY overlaps a specific known SCOPED/UNVERIFIED rule, so these four
 * sections are correctly unflagged simply because no such rule is passed
 * (or, for target_selection, because every claim is locally qualified).
 */
describe("Real-audit v7/v8 — DESCRIPTIVE_MIXED sections mixing genuinely global evidence with properly-qualified scoped material are not false-positive-flagged", () => {
  it("real false positive: key_levels — the polarity-inversion claim has no matching non-global rule (empty pool); unrelated, properly-qualified SCOPED chase/stop rules do not universalize the section", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "key_levels",
          content:
            "A broken key level that gets retested always acts as polarity-inverted support or resistance. " +
            "For options day trading, never chase price more than 0.5% beyond the level. " +
            "Scalpers should tighten stops to the nearest micro key level.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["scalper"] },
          scopeBasis: "SCOPED", // combineScopeBasis: SCOPED dominates once ANY citation is scoped, even with an independently-global one also present — no longer used as a trigger at all (v9)
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["options", "scalper"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: setup_selection — the narrow-specialization claim has no matching non-global rule; beginner/experienced counts are explicitly qualified in prose", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "setup_selection",
          content:
            "Every trader should always specialize narrowly in a small set of setups rather than trading everything. " +
            "Beginners should track no more than two setups at a time. " +
            "Experienced traders may track up to five setups once consistently profitable.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: ["beginner", "experienced"] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["beginner", "experienced"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: risk_management — the 2R claim has no matching non-global rule; beginner/options/scalping rules are explicitly labeled as such in prose", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "risk_management",
          content:
            "Whenever you're trading, what you always want is at least a two R multiple. " +
            "For beginner options traders, risk no more than 1% of account equity per trade. " +
            "Scalping accounts should use a tighter maximum daily loss limit.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner", "scalper"] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["options", "beginner", "scalper"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: target_selection — the section describes alternative target categories, explicitly labeling intraday/premarket/Gap Fill/Fibonacci/daily-weekly contexts; it never claims every target type applies to every strategy (no global pool needed — every claim is locally qualified instead)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "target_selection",
          content:
            "Intraday setups always target the prior session's high or low first. " +
            "Premarket sessions favor the overnight range extremes as the initial target. " +
            "The Gap Fill target applies within Gap Fill setups specifically. " +
            "Fibonacci retracement levels are used as targets in Fibonacci-based strategies. " +
            "On daily and weekly timeframes, targets extend to the prior major swing point.",
          scope: { strategies: ["Gap Fill", "Fibonacci"], marketsOrInstruments: [], timeframes: ["daily", "weekly"], sessions: ["premarket"], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["premarket", "daily", "weekly", "intraday"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("do-not-weaken check: a single sentence combining an erased restriction with genuinely global wording is still flagged (a real non-global match always wins, regardless of whether the SAME sentence also reads as globally backed)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Beginner options traders should risk no more than 1% of account equity on every trade.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "risk_management",
          content: "Always risk no more than 1% of account equity on every trade, and target at least a two R multiple.",
          scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });

  it("collectNonGlobalRuleDescriptions excludes a SCOPED/UNVERIFIED rule description that ALSO appears as a VERIFIED_GLOBAL rule elsewhere (an evidence-class-partitioned rule's sibling) — the real key_levels root cause at its source", async () => {
    const { collectNonGlobalRuleDescriptions } = await import("../src/synthesis/frameworkScopeSplit.js");
    const coreFramework = {
      sections: [
        {
          key: "key_levels",
          title: "Key Levels",
          rules: [
            // Two partitions of the SAME original rule — identical description, by design (see coreFramework.ts's enrichAndPartitionRule) — one VERIFIED_GLOBAL, one SCOPED.
            { description: "A broken key level that gets retested acts as polarity-inverted support or resistance.", classification: "explicit" as const, supportLevel: "MULTI_SOURCE" as const, supportCount: 2, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null, scopeBasis: "VERIFIED_GLOBAL" as const },
            { description: "A broken key level that gets retested acts as polarity-inverted support or resistance.", classification: "explicit" as const, supportLevel: "MULTI_SOURCE" as const, supportCount: 2, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] }, scopeBasis: "SCOPED" as const },
            // A genuinely, exclusively scoped rule with no globally-backed sibling — must still be returned.
            { description: "For options day trading, never chase price more than 0.5% beyond the level.", classification: "explicit" as const, supportLevel: "SINGLE_SOURCE" as const, supportCount: 1, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] }, scopeBasis: "SCOPED" as const },
          ],
        },
      ],
    };
    const descriptions = collectNonGlobalRuleDescriptions(coreFramework as unknown as import("../src/synthesis/schema.js").CoreFramework, []);
    expect(descriptions.map((d) => d.description)).not.toContain("A broken key level that gets retested acts as polarity-inverted support or resistance.");
    expect(descriptions.map((d) => d.description)).toContain("For options day trading, never chase price more than 0.5% beyond the level.");
  });

  it("collectGlobalRuleDescriptions returns exactly the VERIFIED_GLOBAL rule descriptions pooled from CoreFramework and canonical strategies", async () => {
    const { collectGlobalRuleDescriptions } = await import("../src/synthesis/frameworkScopeSplit.js");
    const coreFramework = {
      sections: [
        {
          key: "key_levels",
          title: "Key Levels",
          rules: [
            { description: "A broken key level that gets retested acts as polarity-inverted support or resistance.", classification: "explicit" as const, supportLevel: "MULTI_SOURCE" as const, supportCount: 2, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null, scopeBasis: "VERIFIED_GLOBAL" as const },
            { description: "For options day trading, never chase price more than 0.5% beyond the level.", classification: "explicit" as const, supportLevel: "SINGLE_SOURCE" as const, supportCount: 1, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] }, scopeBasis: "SCOPED" as const },
          ],
        },
      ],
    };
    const descriptions = collectGlobalRuleDescriptions(coreFramework as unknown as import("../src/synthesis/schema.js").CoreFramework, []);
    expect(descriptions.map((d) => d.description)).toEqual(["A broken key level that gets retested acts as polarity-inverted support or resistance."]);
  });
});

/**
 * SEVENTH (part 2) real-data audit regression tests (Phase 3.5B v8) — the
 * real market_context_regime FALSE NEGATIVE the section-level
 * `hasIndependentGlobalEvidence` shortcut caused: "Directional trades must
 * align with the prevailing higher-timeframe trend...never trade
 * counter-trend..." rests on SCOPED beginner + UNVERIFIED evidence with NO
 * VERIFIED_GLOBAL partition at all, yet went undetected because the
 * section ALSO cited something unrelated that WAS global. The five other
 * real leaks named in this round (pre_market_preparation,
 * higher_timeframe_framework, trade_management, and the "must wait for
 * candle closure" vs. Inside Bar contradiction) are all the SAME failure
 * shape: an absolute/general claim, matched only to SCOPED/UNVERIFIED
 * evidence, with no local applicability statement.
 */
describe("Real-audit v8 — sentence-level matching catches real leaks the section-level shortcut missed", () => {
  it("real leak preserved/fixed: market_context_regime — 'Directional trades must align with the prevailing higher-timeframe trend; never trade counter-trend.' rests on SCOPED/UNVERIFIED evidence (no VERIFIED_GLOBAL partition) and is flagged, even though the section's other statements (broad US equity indices..., active intraday momentum trading 9:30-11:00...) are properly qualified", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Directional bias should align with the higher-timeframe trend before entry; never trade counter-trend.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "market_context_regime",
          content:
            "As a foundational principle, trade strictly in the direction of the dominant higher-timeframe trend and market structure; never trade counter-trend. " +
            "Broad US equity indices always confirm the regime before any directional bias is taken. " +
            "Active intraday momentum trading between 9:30 AM and 11:00 AM always requires a confirmed regime read.",
          scope: { strategies: [], marketsOrInstruments: ["equities"], timeframes: [], sessions: ["9:30-11:00"], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["equities", "9:30-11:00"]),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].sectionKey).toBe("market_context_regime");
    expect(result.universalApplicabilityLeaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });

  it("real leak (v9 exact wording): pre_market_preparation — 'As a general baseline, traders conduct top-down macro analysis' followed by scoped intraday/premarket mechanics (PMH/PML, 1h/5m ETH, IBKR Book Trader/hotkeys, QQQ/SPY) is flagged: the generalizing preamble is not locally qualified to the scoped workflow it introduces", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [
      {
        description:
          "As a general baseline, traders conduct top-down macro analysis, marking PMH/PML on the 1h and 5m ETH chart and using IBKR's Book Trader and hotkeys to prepare QQQ/SPY watchlists before the open.",
        basis: "UNVERIFIED" as const,
      },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "pre_market_preparation",
          content:
            "As a general baseline, traders conduct top-down macro analysis, marking PMH/PML on the 1h and 5m ETH chart and using IBKR's Book Trader and hotkeys to prepare QQQ/SPY watchlists before the open.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks.length + result.unverifiedUniversalClaims.length).toBeGreaterThan(0);
  });

  it("real leak (v9 exact wording): higher_timeframe_framework — 'the framework dictates lower-timeframe execution' and '1h/4h are used exclusively for thesis and never execution' — not valid for every strategy/timeframe (swing/higher-timeframe strategies execute directly off 1h/4h) — flagged with no local qualifier and only SCOPED matching evidence", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    // Deliberately no scope/scopeVocabulary overlap with the leak sentence's own wording — the
    // section names its OWN topic ("1h/4h") but that is not, by itself, a stated qualifier for
    // the SEPARATE claim that the framework "dictates" lower-timeframe execution for every
    // strategy (a claim about applicability BEYOND the intraday multi-timeframe workflow, not a
    // restriction of it).
    const nonGlobalRules = [
      { description: "For the intraday multi-timeframe strategies, the framework dictates lower-timeframe execution; 1h/4h are used exclusively for thesis and never execution.", basis: "SCOPED" as const },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "higher_timeframe_framework",
          content: "The framework dictates lower-timeframe execution, and 1h/4h are used exclusively for thesis and never execution.",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
  });

  it("real leak (v9 exact wording): trade_management — 'Traders must always scale out' 50%-80% at the first target with 10%-20% runners is flagged: scaling mechanics are scoped to intraday/momentum contexts, not course-wide mechanics, with no local qualifier and only SCOPED/UNVERIFIED matching evidence", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [
      { description: "For intraday momentum trades, traders should scale out 50% to 80% of the position at the first target, letting the remaining 10% to 20% run as a runner.", basis: "UNVERIFIED" as const },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "trade_management",
          content: "Traders must always scale out 50% to 80% of the position at the first target, letting the remaining 10% to 20% run as a runner.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks.length + result.unverifiedUniversalClaims.length).toBeGreaterThan(0);
  });

  it("confirmation contradiction: 'Traders must wait for candle closure...' stated as an absolute requirement is flagged by the audit when its matched source rule is SCOPED/UNVERIFIED and Inside Bar's own direct-entry exception is not locally stated", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Wait for candle closure to confirm structural respect or rejection before entering.", basis: "UNVERIFIED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "confirmation_framework",
          content: "Traders must wait for candle closure to confirm structural respect or rejection before entering a position.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks.length + result.unverifiedUniversalClaims.length).toBeGreaterThan(0);
  });

  it("the same candle-closure sentence is NOT flagged once it locally states the Inside Bar exception — proves the fix is about wording qualification, not audit suppression", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "confirmation_framework",
          content: "For setups other than Inside Bar's resting buy-stop/sell-stop direct-entry exception, always wait for candle closure to confirm structural respect or rejection before entering.",
          scope: { strategies: ["Inside Bar"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });

  it("confirmation_framework must remain accepted (v9 required outcome) once it explicitly names ALL THREE exceptions — Inside Bar, Trendline Break, and ORB — not just Inside Bar alone (real matching SCOPED rule included, proving qualification defeats the leak rather than an empty rule pool)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Always wait for candle closure to confirm structural respect or rejection before entering a position.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "confirmation_framework",
          content:
            "For setups other than the Inside Bar's resting buy-stop/sell-stop direct entry, the Trendline Break's break-of-trendline direct entry, and the ORB's opening-range-break direct entry, " +
            "always wait for candle closure to confirm structural respect or rejection before entering a position.",
          scope: { strategies: ["Inside Bar", "Trendline Break", "ORB"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });
});

/**
 * Real-audit v9, Part 2 (remaining coverage) — the four required real
 * no-leak sections not yet exercised by a dedicated test (course_philosophy,
 * entry_framework, common_mistakes_warnings — target_selection/setup_selection/
 * key_levels/risk_management/strategy_variants/confirmation_framework already
 * covered above), plus the ONE remaining real leak (no_trade_conditions) whose
 * underlying mechanism (B: collection-declaration) had zero test coverage
 * anywhere in this file until now.
 */
describe("Real-audit v9 — remaining required no-leak sections and the no_trade_conditions collection-declaration leak (mechanism B)", () => {
  it("no-leak: course_philosophy — general course framing/philosophy prose with no unqualified absolute rule matching any SCOPED/UNVERIFIED evidence", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "course_philosophy",
          content:
            "This course teaches a structured, evidence-based approach to reading price action and market structure. " +
            "The goal is to build a repeatable process for evaluating setups rather than trading on impulse.",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      [],
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("no-leak: entry_framework must remain accepted (v9 required outcome) — it explicitly states a default for breakout/continuation setups and then names the direct-entry exceptions", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [
      { description: "For breakout and continuation setups, wait for a confirmed retest before entering.", basis: "SCOPED" as const },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "entry_framework",
          content:
            "By default, for breakout and continuation setups, always wait for a confirmed retest before entering. " +
            "The Inside Bar, Trendline Break, and ORB strategies are direct-entry exceptions to this default and do not require a retest.",
          scope: { strategies: ["breakout", "continuation"], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });

  it("no-leak: common_mistakes_warnings — cautionary prose describing frequently observed mistakes, phrased as observations/warnings rather than unqualified universal rules", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [
      { description: "For momentum day trading, chasing an extended move without a pullback is a common mistake.", basis: "UNVERIFIED" as const },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "common_mistakes_warnings",
          content:
            "A common mistake in momentum day trading is chasing an extended move without waiting for a pullback. " +
            "Traders are cautioned to size positions appropriately for the volatility of the specific instrument being traded.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real leak (v9 exact wording, mechanism B): no_trade_conditions — 'The following explicit no-trade filters govern all playbook operations' declares a universal collection, but the list contains scoped rules (mandatory retests, 9:30-11:00 cutoff, VWAP directional rules, stock 'In Play', HOD/LOD-specific mechanics) — flagged via the collection-declaration sentence, not per-sentence absolute-claim matching", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [
      { description: "A mandatory retest of the flipped level is required before entry.", basis: "SCOPED" as const },
      { description: "No new trades may be initiated outside the 9:30 to 11:00 AM session window.", basis: "SCOPED" as const },
      { description: "Directional bias must respect VWAP as support or resistance before entry.", basis: "SCOPED" as const },
      { description: "The stock must be classified as 'In Play' with elevated relative volume before a setup qualifies.", basis: "SCOPED" as const },
      { description: "HOD/LOD-specific mechanics govern when scaling out of a momentum position.", basis: "UNVERIFIED" as const },
    ];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "no_trade_conditions",
          content:
            "The following explicit no-trade filters govern all playbook operations: " +
            "a mandatory retest of the flipped level is required before entry; " +
            "no new trades may be initiated outside the 9:30 to 11:00 AM session window; " +
            "directional bias must respect VWAP as support or resistance before entry; " +
            "the stock must be classified as 'In Play' with elevated relative volume before a setup qualifies; " +
            "and HOD/LOD-specific mechanics govern when scaling out of a momentum position.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
          scopeBasis: "UNVERIFIED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks.length + result.unverifiedUniversalClaims.length).toBeGreaterThan(0);
    expect(result.universalApplicabilityLeaks.some((leak) => leak.sectionKey === "no_trade_conditions") || result.unverifiedUniversalClaims.some((leak) => leak.sectionKey === "no_trade_conditions")).toBe(true);
  });

  it("no_trade_conditions is NOT flagged once the collection-declaration sentence is removed and each filter is qualified by its own scope individually, with a genuinely universal rule kept separate", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "no_trade_conditions",
          content:
            "For setups requiring a retest, a mandatory retest of the flipped level is required before entry. " +
            "For intraday momentum strategies, no new trades may be initiated outside the 9:30 to 11:00 AM session window. " +
            "Never risk more than the predefined stop-loss amount on any single trade.",
          scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: ["9:30-11:00"], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
        },
      ],
      new Set(["9:30-11:00"]),
      [],
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
  });
});

/**
 * THIRD real-data audit regression tests (Phase 3.5B v4) — see PR #13's
 * third real 28-lesson dry-run audit ("upstream scope aggregation").
 * CoreFramework's own scope union could come out empty (and be treated as
 * safely global downstream) purely because a consolidated rule was built
 * from pre-3.5B per-lesson `Strategy` rules (market_context_rules,
 * confirmation_rules, etc.) — data that was NEVER scope-tagged in the
 * first place, unlike a Phase 3.5A KnowledgeItem. `scopeBasis` (see
 * scopeBasis.ts) distinguishes "VERIFIED_GLOBAL" (every citation was
 * scope-aware and none were scoped) from "UNVERIFIED" (no scope-aware
 * evidence at all) so an absence of evidence is never read as evidence of
 * globality.
 */
describe("Real-audit v4 — scopeBasis.ts's aggregateScopeBasis distinguishes verified-global, scoped, and unverified evidence", () => {
  it("cites ONLY scope-aware KnowledgeItems, all global -> VERIFIED_GLOBAL", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const globalItem = makeKnowledgeItem({ statement: "Define risk before entry.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1"], (key) => (key === "k1" ? { item: globalItem } : undefined));
    expect(result.scope).toBeNull();
    expect(result.scopeBasis).toBe("VERIFIED_GLOBAL");
  });

  it("cites a scoped KnowledgeItem -> SCOPED, scope preserved exactly", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const scopedItem = makeKnowledgeItem({ statement: "2R minimum for options beginners.", scope: emptyScope({ marketsOrInstruments: ["options"], traderProfiles: ["beginner"] }) });
    const result = aggregateScopeBasis(["k1"], (key) => (key === "k1" ? { item: scopedItem } : undefined));
    expect(result.scope).toEqual({ strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] });
    expect(result.scopeBasis).toBe("SCOPED");
  });

  it("cites ONLY a scope-blind (legacy, no-KnowledgeItem) source -> UNVERIFIED, never VERIFIED_GLOBAL", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    // `{ item: undefined }` is exactly what coreFramework.ts/canonicalStrategy.ts return for a
    // real citation into the pre-3.5B per-lesson Strategy-rule pool (market_context_rules, etc.).
    const result = aggregateScopeBasis(["s1"], (key) => (key === "s1" ? { item: undefined } : undefined));
    expect(result.scope).toBeNull();
    expect(result.scopeBasis).toBe("UNVERIFIED");
  });

  it("mixes a genuinely-global KnowledgeItem citation with a scope-blind legacy citation -> UNVERIFIED, not diluted back to VERIFIED_GLOBAL", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const globalItem = makeKnowledgeItem({ statement: "Define risk before entry.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1", "s1"], (key) => {
      if (key === "k1") return { item: globalItem };
      if (key === "s1") return { item: undefined };
      return undefined;
    });
    expect(result.scope).toBeNull();
    expect(result.scopeBasis).toBe("UNVERIFIED");
  });

  it("zero valid citations (all invented/unknown keys) -> UNVERIFIED, not VERIFIED_GLOBAL by default", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const result = aggregateScopeBasis(["ghost"], () => undefined);
    expect(result.scopeBasis).toBe("UNVERIFIED");
  });
});

describe("Real-audit v4, Proof 1 — CoreFramework consolidated rules cannot be falsely certified global via scope-blind (legacy per-lesson Strategy-rule) citations", () => {
  it("a consolidated rule built ONLY from legacy market_context_rules citations (the exact 'Intraday Fundamentals / QQQ-SPY' real-audit failure) gets scopeBasis UNVERIFIED, never VERIFIED_GLOBAL, even though its scope union is empty", async () => {
    const instance = makeInstance({
      strategy: makeStrategy({
        market_context_rules: [
          { description: "Confirm Intraday Fundamentals and QQQ/SPY relative strength/order flow before entering any trade.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" },
        ],
      }),
    });

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          // Cites k1 — the ONLY entry in the pool, since the instance's strategy has one
          // market_context_rules entry and no knowledgeSources are supplied at all.
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "setup_qualification",
                  title: "Foundational Setup Qualification",
                  rules: [
                    {
                      description: "Before entering any trade, evaluate the five foundational qualification criteria (including Intraday Fundamentals and QQQ/SPY relative strength/order flow).",
                      classification: "explicit",
                      supportLevel: "SINGLE_SOURCE",
                      supportCount: 1,
                      sourceKeys: ["k1"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [instance]);

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scope).toBeNull();
    // The real-audit failure: this used to read as "safe to treat as global" (scope: null).
    // It is now UNVERIFIED — we simply never had scope-aware evidence to certify it either way.
    expect(rule.scopeBasis).toBe("UNVERIFIED");
  });

  it("a consolidated rule built from a genuinely global KnowledgeItem citation (no legacy citation involved) gets VERIFIED_GLOBAL, so real course-wide rules are not thrown out by this fix", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk on every trade before entering.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] },
      },
    ];
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "risk", title: "Risk", rules: [{ description: "Always define your risk on every trade before entering.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scope).toBeNull();
    expect(rule.scopeBasis).toBe("VERIFIED_GLOBAL");
  });

  it("real-audit fix v5: mixing a legacy market_context_rules citation with a genuinely global KnowledgeItem citation on ONE Gemini-authored rule is PARTITIONED into two separate output rules — global evidence is never diluted away by the unverifiable part, and the unverifiable part is never laundered into global either", async () => {
    const instance = makeInstance({
      // Deliberately no named instrument/timeframe/session here (unlike the v7 test below) —
      // this test's own purpose is to isolate partitioning-by-EVIDENCE-CLASS from the v7
      // shared-description restriction gate; the two are independent mechanisms.
      strategy: makeStrategy({ market_context_rules: [{ description: "Confirm relative strength and order flow alignment.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }] }),
    });
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk on every trade before entering.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          // k1 = the market_context_rules legacy entry (pooled first), k2 = the global KnowledgeItem.
          return {
            text: JSON.stringify({
              sections: [{ key: "setup", title: "Setup", rules: [{ description: "Confirm relative strength and order flow alignment and always define your risk on every trade.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 2, sourceKeys: ["k1", "k2"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [instance], normalized.globalItems);

    // Real-audit fix (v5) — this real dry-run failure (the "2R rule") showed the OLD behavior
    // (one diluted UNVERIFIED rule) was itself wrong: it threw away independently-sufficient
    // global evidence. Both rules now survive, each carrying only its own evidence class.
    const rules = coreFramework.sections[0].rules;
    expect(rules).toHaveLength(2);
    const globalRule = rules.find((r) => r.scopeBasis === "VERIFIED_GLOBAL");
    const unverifiedRule = rules.find((r) => r.scopeBasis === "UNVERIFIED");
    expect(globalRule).toBeDefined();
    expect(unverifiedRule).toBeDefined();
    expect(globalRule!.description).toBe("Confirm relative strength and order flow alignment and always define your risk on every trade.");
    expect(unverifiedRule!.description).toBe("Confirm relative strength and order flow alignment and always define your risk on every trade.");
    expect(globalRule!.scope).toBeNull();
    expect(unverifiedRule!.scope).toBeNull();
  });

  it("real-audit fix (v7): when a PARTITIONED rule's SHARED final description itself names a restriction (e.g. 'Confirm QQQ/SPY alignment'), NEITHER partition may claim VERIFIED_GLOBAL — downstream consumers only ever see this one emitted description, regardless of which citation contributed which words", async () => {
    const instance = makeInstance({
      strategy: makeStrategy({ market_context_rules: [{ description: "Confirm QQQ/SPY alignment.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }] }),
    });
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk before entering a trade.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "setup", title: "Setup", rules: [{ description: "Confirm QQQ/SPY alignment and always define your risk.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 2, sourceKeys: ["k1", "k2"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [instance], normalized.globalItems);

    // Partitioning-by-evidence-class still happens (2 rules, one per class) — that mechanism
    // is untouched. What changed is that NEITHER may now claim VERIFIED_GLOBAL, because both
    // share the one emitted description and that description names "QQQ/SPY".
    const rules = coreFramework.sections[0].rules;
    expect(rules).toHaveLength(2);
    for (const rule of rules) {
      expect(rule.description).toBe("Confirm QQQ/SPY alignment and always define your risk.");
      expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
    }
    expect(rules.every((r) => r.scopeBasis === "UNVERIFIED")).toBe(true);
    // Conservative reclassification, never deletion — both partitions, their sources, and
    // their numerical values/exceptions all still survive in the output.
    expect(rules.flatMap((r) => r.sources).length).toBeGreaterThan(0);
  });
});

/**
 * FIFTH real-data audit regression tests (Phase 3.5B v6) — see PR #13's
 * fifth real 28-lesson dry-run audit. The v3-v5 fixes above correctly track
 * WHY a rule's scope union came out empty (scope-blind legacy citation vs.
 * scope-aware KnowledgeItem), but never questioned whether an empty
 * STRUCTURED scope on a scope-aware KnowledgeItem is itself trustworthy.
 * The real failure: a CoreFramework rule reading "In options day trading,
 * scale out 50% to 80% ..." was classified `scope: null, scopeBasis:
 * VERIFIED_GLOBAL` — "no structured scope was extracted" was being read as
 * "positively verified universal applicability." scopeBasis.ts's
 * `finalizeScopeBasis` (applied in both coreFramework.ts and
 * canonicalStrategy.ts, after aggregateScopeBasis) is the fix: it only ever
 * downgrades VERIFIED_GLOBAL to UNVERIFIED — never promotes, never drops
 * the rule — when the rule's own final text names a restriction the
 * structured scope missed, or when the rule documents a genuine
 * methodological conflict (supportLevel CONFLICTING).
 */
describe("Real-audit v6 — VERIFIED_GLOBAL eligibility: a rule/citation whose structured scope is empty is not automatically 'verified global'", () => {
  it("exact real-audit failure: a CoreFramework rule consolidated from a citation with empty structured scope, but whose own text says 'In options day trading, scale out 50% to 80%...', is UNVERIFIED — MUST NOT become VERIFIED_GLOBAL", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "In options day trading, scale out 50% to 80% of the position at the first target.", scope: emptyScope() })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "trade_management",
                  title: "Trade Management",
                  rules: [
                    {
                      description: "In options day trading, scale out 50% to 80% of the position at the first target.",
                      classification: "explicit",
                      supportLevel: "SINGLE_SOURCE",
                      supportCount: 1,
                      sourceKeys: ["k1"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);

    const rule = coreFramework.sections[0].rules[0];
    // Structured extraction still came out empty (the acknowledged Phase 3.5A gap) —
    // but the rule's own text names an instrument/session restriction, so it may
    // never power a universal requirement.
    expect(rule.scope).toBeNull();
    expect(rule.scopeBasis).toBe("UNVERIFIED");
  });

  it("genuine broad claim: 'Whenever you're trading, you always want at least a two R multiple' with sufficiently broad independent (unscoped) evidence MAY remain VERIFIED_GLOBAL", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "Whenever you're trading, you always want at least a two R multiple.", scope: emptyScope() })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
      {
        analysisId: 2,
        lessonId: 11,
        lessonTitle: "Lesson 11",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "On all trades, target at least a 2R reward-to-risk ratio before considering an exit.", scope: emptyScope() })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "risk_management",
                  title: "Risk Management",
                  rules: [
                    {
                      description: "Whenever you're trading, you always want at least a two R multiple on every trade.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 2,
                      sourceKeys: ["k1", "k2"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scope).toBeNull();
    expect(rule.scopeBasis).toBe("VERIFIED_GLOBAL");
  });

  it("a rule documenting a genuine methodological CONFLICT (supportLevel CONFLICTING) is never VERIFIED_GLOBAL, even with empty structured scope and no restriction language in its text", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always wait for candle close before entry.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "entry_framework",
                  title: "Entry Framework",
                  rules: [
                    {
                      description: "Always wait for candle close before entry.",
                      classification: "explicit",
                      supportLevel: "CONFLICTING",
                      supportCount: 1,
                      sourceKeys: ["k1"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scopeBasis).toBe("UNVERIFIED");
  });

  it("aggregateScopeBasis (citation level): a scope-aware KnowledgeItem citation whose structured scope is empty but whose OWN statement names a restriction is routed the same as scope-blind evidence — UNVERIFIED, not VERIFIED_GLOBAL", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const restrictedButUnscopedItem = makeKnowledgeItem({ statement: "In options day trading, scale out 50% to 80% of the position.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1"], (key) => (key === "k1" ? { item: restrictedButUnscopedItem } : undefined));
    expect(result.scope).toBeNull();
    expect(result.scopeBasis).toBe("UNVERIFIED");
  });

  it("finalizeScopeBasis never promotes SCOPED or UNVERIFIED to VERIFIED_GLOBAL, and never touches a basis it doesn't downgrade", async () => {
    const { finalizeScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    expect(finalizeScopeBasis("SCOPED", "In options day trading, scale out.", undefined)).toBe("SCOPED");
    expect(finalizeScopeBasis("UNVERIFIED", "In options day trading, scale out.", undefined)).toBe("UNVERIFIED");
    // v8: needs positive proof too — explicit positive universal language in the description alone is sufficient.
    expect(finalizeScopeBasis("VERIFIED_GLOBAL", "Always define your risk on every trade before entry.", undefined)).toBe("VERIFIED_GLOBAL");
  });

  it("UNVERIFIED rules are not dropped — they remain present in CoreFramework output, just ineligible to power the Master Trading Checklist", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "In options day trading, scale out 50% to 80% of the position.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "trade_management", title: "Trade Management", rules: [{ description: "In options day trading, scale out 50% to 80% of the position.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);
    const { selectVerifiedGlobalCoreFrameworkRules } = await import("../src/synthesis/runSynthesis.js");

    expect(coreFramework.sections[0].rules).toHaveLength(1);
    expect(coreFramework.sections[0].rules[0].scopeBasis).toBe("UNVERIFIED");
    // Master checklist selection naturally excludes it — no redesign needed there.
    expect(selectVerifiedGlobalCoreFrameworkRules(coreFramework)).toHaveLength(0);
  });
});

/**
 * SIXTH real-data audit regression tests (Phase 3.5B v7) — see PR #13's
 * sixth real 28-lesson dry-run audit. The v6 fix correctly stopped an empty
 * STRUCTURED scope from being read as "verified global," but its own
 * finalizeScopeBasis call was skipped for a PARTITIONED (evidence-class-
 * split) rule, on the theory that the shared merged description could name
 * a restriction belonging to a different partition. Real data proved that
 * theory unsafe: every partition emits the SAME description to downstream
 * consumers, so if THAT text names a restriction, no partition sharing it
 * may claim VERIFIED_GLOBAL. Three concrete real CoreFramework rules
 * leaked through as VERIFIED_GLOBAL this way.
 */
describe("Real-audit v7 — the VERIFIED_GLOBAL restriction gate applies to every emitted rule partition, not just unsplit rules", () => {
  /** Builds a CoreFramework where ONE Gemini rule cites both a scope-blind legacy rule (forcing a partition split) and a genuinely-unscoped KnowledgeItem, so the resulting rule is guaranteed to be partitioned into 2 (mirroring the real production shape) even though this test only cares about the final scopeBasis of whichever partition would otherwise have been VERIFIED_GLOBAL. */
  async function buildPartitionedRule(description: string) {
    const instance = makeInstance({
      strategy: makeStrategy({ market_context_rules: [{ description: "Confirm order flow context.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }] }),
    });
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: description, scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "trade_management", title: "Trade Management", rules: [{ description, classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 2, sourceKeys: ["k1", "k2"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [instance], normalized.globalItems);
    return coreFramework.sections[0].rules;
  }

  it("real failure A: \"For momentum day trading, standard candlestick charts and Level 2 order flow provide sufficient confirmation before entry.\" MUST NOT become VERIFIED_GLOBAL, even as a partitioned rule", async () => {
    const rules = await buildPartitionedRule("For momentum day trading, standard candlestick charts and Level 2 order flow provide sufficient confirmation before entry.");
    for (const rule of rules) expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("real failure B: \"In momentum day trading, scale out partial profits — 50% to 80% of the position at the first target, retaining a 10% to 20% runner for extended moves.\" MUST NOT become VERIFIED_GLOBAL, even as a partitioned rule", async () => {
    const rules = await buildPartitionedRule("In momentum day trading, scale out partial profits — 50% to 80% of the position at the first target, retaining a 10% to 20% runner for extended moves.");
    for (const rule of rules) expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("real failure C: \"For momentum day trading, use direct-access broker platforms (such as Interactive Brokers) with a Book Trader or hotkeys interface to execute quickly during fast momentum entries.\" MUST NOT become VERIFIED_GLOBAL, even as a partitioned rule", async () => {
    const rules = await buildPartitionedRule("For momentum day trading, use direct-access broker platforms (such as Interactive Brokers) with a Book Trader or hotkeys interface to execute quickly during fast momentum entries.");
    for (const rule of rules) expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("genuine broad claim survives partitioning: \"Whenever you're trading, what you always want is at least a two R multiple\" with multiple independent broad sources MAY remain VERIFIED_GLOBAL even as a partitioned rule", async () => {
    const rules = await buildPartitionedRule("Whenever you're trading, what you always want is at least a two R multiple.");
    expect(rules.some((r) => r.scopeBasis === "VERIFIED_GLOBAL")).toBe(true);
  });

  it("no evidence or provenance is dropped by the reclassification — every partition, its sources, and the rule's numerical values all still survive in the output", async () => {
    const rules = await buildPartitionedRule("For momentum day trading, scale out 50% to 80% of the position.");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.flatMap((r) => r.sources).length).toBeGreaterThan(0);
  });

  it("Master Checklist invariant (v7): assertMasterChecklistSourcesGlobal independently re-runs the restriction gate against each selected rule's own description and rejects one that shouldn't have been marked VERIFIED_GLOBAL, even if scopeBasis was set incorrectly upstream", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const mislabeledRule = {
      description: "For momentum day trading, standard candlestick charts provide sufficient confirmation.",
      classification: "explicit" as const,
      supportLevel: "SINGLE_SOURCE" as const,
      supportCount: 1,
      sources: [],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: null,
      scopeBasis: "VERIFIED_GLOBAL" as const, // incorrectly set upstream — the invariant must catch this independently
    };
    expect(() => assertMasterChecklistSourcesGlobal([mislabeledRule])).toThrow(/restriction gate|VERIFIED_GLOBAL/);
  });

  it("Master Checklist invariant (v7/v8): a genuinely unrestricted VERIFIED_GLOBAL rule with >=2 distinct-lesson sources (the v8 positive-proof requirement, re-derived from `sources` at this checkpoint) passes the independent re-check without throwing", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const sourceRef = { lessonTitle: "L", strategyInstanceId: null, startTimestamp: null, endTimestamp: null, evidence: "e" };
    const genuineRule = {
      description: "Always define your risk before entering a trade.",
      classification: "explicit" as const,
      supportLevel: "MULTI_SOURCE" as const,
      supportCount: 2,
      sources: [
        { ...sourceRef, lessonId: 10 },
        { ...sourceRef, lessonId: 11 },
      ],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: null,
      scopeBasis: "VERIFIED_GLOBAL" as const,
    };
    expect(() => assertMasterChecklistSourcesGlobal([genuineRule])).not.toThrow();
  });
});

/**
 * SEVENTH real-data audit regression tests (Phase 3.5B v8) — see PR #13's
 * seventh real 28-lesson dry-run audit. The v6/v7 fixes correctly stop
 * "no detected restriction" from being read as "verified global" — but
 * absence of a detected restriction is STILL not the same claim as
 * POSITIVE proof of universality. Three concrete real rules, each backed
 * by only ONE lesson and containing no restriction keyword, leaked through
 * as VERIFIED_GLOBAL this way. scopeBasis.ts's finalizeScopeBasis now also
 * requires: (1) support from >=2 DISTINCT lesson IDs whose evidence is
 * itself unscoped/unrestricted, OR (2) explicit positive universal
 * applicability language ("every trade", "all trades", "whenever you're
 * trading", etc — never generic words like "always" alone).
 */
describe("Real-audit v8 — VERIFIED_GLOBAL requires POSITIVE proof of universality, not merely the absence of a detected restriction", () => {
  async function buildSingleLessonRule(sectionKey: string, text: string) {
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: text, scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: sectionKey, title: sectionKey, rules: [{ description: text, classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);
    return coreFramework.sections[0].rules[0];
  }

  it("real failure A: candle-close confirmation rule ('Always wait for candle closure to confirm structural respect or rejection...'), one lesson, no explicit positive language => NOT VERIFIED_GLOBAL — directly conflicts with the canonical Inside Bar strategy's own resting buy-stop/sell-stop exception", async () => {
    const rule = await buildSingleLessonRule(
      "entry_framework",
      "Always wait for candle closure to confirm structural respect or rejection before entering a position.",
    );
    expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("real failure B: HOD/LOD scale-out rule ('Scale out partial profits at the initial key structural liquidity level, such as session High of Day for longs or Low of Day for shorts'), one lesson => NOT VERIFIED_GLOBAL — session/intraday trade-management guidance, not proof every strategy/timeframe uses HOD/LOD scaling", async () => {
    const rule = await buildSingleLessonRule(
      "trade_management",
      "Scale out partial profits at the initial key structural liquidity level, such as session High of Day for longs or Low of Day for shorts.",
    );
    expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("real failure C: 25%-50% starter-position sizing rule ('When taking early or feeling-out entries, use a starter position of 25% to 50%...'), one lesson => NOT VERIFIED_GLOBAL — a specific sizing technique, not positively verified as course-wide", async () => {
    const rule = await buildSingleLessonRule(
      "risk_management",
      "When taking early or feeling-out entries, use a starter position of 25% to 50% of your normal size.",
    );
    expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("genuine 2R rule remains VERIFIED_GLOBAL: multiple independent (distinct-lesson) sources, including explicit positive universal language ('Whenever you're trading, what you always want is at least a two R multiple.')", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Whenever you're trading, what you always want is at least a two R multiple.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
      { analysisId: 2, lessonId: 11, lessonTitle: "Lesson 11", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Target at least a 2R reward-to-risk ratio before considering an exit on any position.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "risk_management",
                  title: "Risk Management",
                  rules: [
                    {
                      description: "Whenever you're trading, what you always want is at least a two R multiple.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 2,
                      sourceKeys: ["k1", "k2"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);
    expect(coreFramework.sections[0].rules[0].scopeBasis).toBe("VERIFIED_GLOBAL");
  });

  it("distinct-lesson counting: 2 citations from the SAME lesson do NOT satisfy the '>=2 distinct lesson IDs' requirement — only a genuinely independent second lesson counts", async () => {
    const { aggregateScopeBasis, finalizeScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const itemA = makeKnowledgeItem({ statement: "Scale out at the initial liquidity level.", scope: emptyScope() });
    const itemB = makeKnowledgeItem({ statement: "Take partial profits at the first target level.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1", "k2"], (key) => {
      if (key === "k1") return { item: itemA, lessonId: 10 };
      if (key === "k2") return { item: itemB, lessonId: 10 }; // SAME lesson as k1
      return undefined;
    });
    expect(new Set(result.unscopedEvidenceLessonIds).size).toBe(1);
    expect(finalizeScopeBasis("VERIFIED_GLOBAL", "Scale out at the initial liquidity level.", undefined, result.unscopedEvidenceLessonIds, result.citationHadPositiveLanguage)).toBe("UNVERIFIED");
  });

  it("do-not-weaken check: generic absolute words alone ('always', 'all the time', 'personally') are NOT sufficient positive proof, even repeated", async () => {
    const { containsExplicitPositiveUniversalLanguage } = await import("../src/synthesis/scopeBasis.js");
    expect(containsExplicitPositiveUniversalLanguage("I always personally do this all the time on my own trades.")).toBe(false);
    expect(containsExplicitPositiveUniversalLanguage("Every trade needs a defined stop.")).toBe(true);
    expect(containsExplicitPositiveUniversalLanguage("This applies to all trades, no exceptions.")).toBe(true);
    expect(containsExplicitPositiveUniversalLanguage("Whenever you're trading, risk management comes first.")).toBe(true);
  });

  it("Master Checklist invariant (v8): rejects a rule marked VERIFIED_GLOBAL that fails ONLY the positive-proof requirement (single-lesson source, no positive language) — the SAME finalizeScopeBasis function, re-run with sources-derived lesson IDs", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const { SynthesisInvariantError } = await import("../src/synthesis/errors.js");
    const singleLessonRule = {
      description: "Scale out partial profits at the initial key structural liquidity level.",
      classification: "explicit" as const,
      supportLevel: "SINGLE_SOURCE" as const,
      supportCount: 1,
      sources: [{ lessonId: 10, lessonTitle: "L", strategyInstanceId: null, startTimestamp: null, endTimestamp: null, evidence: "e" }],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: null,
      scopeBasis: "VERIFIED_GLOBAL" as const, // incorrectly set upstream
    };
    expect(() => assertMasterChecklistSourcesGlobal([singleLessonRule])).toThrow(SynthesisInvariantError);
  });
});

/**
 * EIGHTH real-data audit regression tests (Phase 3.5B v9) — see PR #13's
 * eighth real 28-lesson dry-run audit. The v8 multi-lesson positive-proof
 * path itself was exploitable: a candle-color/hide-P&L rule stayed
 * VERIFIED_GLOBAL because it cited TWO structurally unscoped KnowledgeItems
 * from two distinct lessons, even though both citations' own statements
 * openly limit the recommendation to a subset of traders ("A lot of people
 * don't like the green and red...", "Me personally...", "Some people cannot
 * actually bear to see a red candlestick...", "people that are scared of
 * candlesticks..."). scopeBasis.ts's containsConditionalEvidenceLanguage
 * closes this gap: such a citation no longer counts toward the required
 * ">=2 distinct lessons," though it is never deleted and the base
 * scopeBasis computation is otherwise unaffected.
 */
describe("Real-audit v9 — conditional/subset/preference evidence language does not count toward the multi-lesson positive-proof path", () => {
  it("real failure: candle-color/hide-P&L rule cited from two distinct lessons, both structurally unscoped but each textually limited to a subset of traders => NOT VERIFIED_GLOBAL", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 8,
        lessonTitle: "Lesson 8",
        knowledge: {
          summary: "s",
          knowledgeItems: [
            makeKnowledgeItem({
              statement: "A lot of people don't like the green and red candles, so consider neutral chart colors. Me personally, I find it helps to hide live P&L too.",
              scope: emptyScope(),
            }),
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
      {
        analysisId: 2,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [
            makeKnowledgeItem({
              statement: "Some people cannot actually bear to see a red candlestick, and people that are scared of candlesticks should switch to neutral tones and hide their live P&L.",
              scope: emptyScope(),
            }),
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "risk_management",
                  title: "Risk Management",
                  rules: [
                    {
                      description: "Alleviate visual emotional triggers by changing chart candle colors away from traditional green/red to neutral tones, and consider hiding live P&L to reduce emotional decision-making.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 2,
                      sourceKeys: ["k1", "k2"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.globalItems);
    expect(coreFramework.sections[0].rules[0].scopeBasis).not.toBe("VERIFIED_GLOBAL");
  });

  it("do-not-delete-evidence check: the filtered citations' numerical values/exceptions still survive in the output even though the rule is downgraded", async () => {
    const { aggregateScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const itemA = makeKnowledgeItem({ statement: "A lot of people find it helpful to use neutral candle colors.", scope: emptyScope(), exceptions: ["skip if colorblind-friendly palette already in use"] });
    const itemB = makeKnowledgeItem({ statement: "Some people cannot bear to see a red candlestick.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1", "k2"], (key) => {
      if (key === "k1") return { item: itemA, lessonId: 8 };
      if (key === "k2") return { item: itemB, lessonId: 10 };
      return undefined;
    });
    expect(result.unscopedEvidenceLessonIds).toEqual([]);
    expect(result.exceptions).toContain("skip if colorblind-friendly palette already in use");
  });

  it("mixed case: one conditional-language citation and one genuinely broad citation from a DIFFERENT lesson still only count as 1 distinct broad lesson => NOT enough alone for the multi-lesson path", async () => {
    const { aggregateScopeBasis, finalizeScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    const conditionalItem = makeKnowledgeItem({ statement: "A lot of people prefer neutral chart colors.", scope: emptyScope() });
    const broadItem = makeKnowledgeItem({ statement: "Reducing visual stress improves decision quality during live trading.", scope: emptyScope() });
    const result = aggregateScopeBasis(["k1", "k2"], (key) => {
      if (key === "k1") return { item: conditionalItem, lessonId: 8 };
      if (key === "k2") return { item: broadItem, lessonId: 15 };
      return undefined;
    });
    expect(result.unscopedEvidenceLessonIds).toEqual([15]);
    expect(
      finalizeScopeBasis("VERIFIED_GLOBAL", "Reduce visual stress to improve decision quality.", undefined, result.unscopedEvidenceLessonIds, result.citationHadPositiveLanguage),
    ).toBe("UNVERIFIED");
  });

  it("explicit genuine universal language still satisfies the explicit-universal path even when OTHER citations carry conditional language", async () => {
    const { containsConditionalEvidenceLanguage, containsExplicitPositiveUniversalLanguage } = await import("../src/synthesis/scopeBasis.js");
    expect(containsConditionalEvidenceLanguage("A lot of people find this helpful, but personally I always do it on every trade.")).toBe(true);
    expect(containsExplicitPositiveUniversalLanguage("A lot of people find this helpful, but personally I always do it on every trade.")).toBe(true);
  });

  it("re-confirms the previous real failures remain NOT VERIFIED_GLOBAL after this fix: candle-close rule, HOD/LOD scaling rule, 25%-50% starter-size rule", async () => {
    const { finalizeScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    expect(finalizeScopeBasis("VERIFIED_GLOBAL", "Always wait for candle closure to confirm structural respect or rejection before entering a position.", undefined, [10], false)).toBe("UNVERIFIED");
    expect(
      finalizeScopeBasis(
        "VERIFIED_GLOBAL",
        "Scale out partial profits at the initial key structural liquidity level, such as session High of Day for longs or Low of Day for shorts.",
        undefined,
        [10],
        false,
      ),
    ).toBe("UNVERIFIED");
    expect(finalizeScopeBasis("VERIFIED_GLOBAL", "When taking early or feeling-out entries, use a starter position of 25% to 50% of your normal size.", undefined, [10], false)).toBe("UNVERIFIED");
  });

  it("genuine 2R rule remains VERIFIED_GLOBAL after this fix: two distinct lessons, neither carrying conditional/subset language", async () => {
    const { finalizeScopeBasis } = await import("../src/synthesis/scopeBasis.js");
    expect(
      finalizeScopeBasis("VERIFIED_GLOBAL", "Whenever you're trading, what you always want is at least a two R multiple.", undefined, [10, 11], false),
    ).toBe("VERIFIED_GLOBAL");
  });

  it("Master Checklist invariant (v9): independently rejects a rule whose sources' quoted evidence carries only conditional/subset language, even across 2 distinct lessons", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const { SynthesisInvariantError } = await import("../src/synthesis/errors.js");
    const conditionalRule = {
      description: "Alleviate visual emotional triggers by changing chart candle colors to neutral tones and hiding live P&L.",
      classification: "explicit" as const,
      supportLevel: "MULTI_SOURCE" as const,
      supportCount: 2,
      sources: [
        { lessonId: 8, lessonTitle: "L8", strategyInstanceId: null, startTimestamp: null, endTimestamp: null, evidence: "A lot of people don't like the green and red candles." },
        { lessonId: 10, lessonTitle: "L10", strategyInstanceId: null, startTimestamp: null, endTimestamp: null, evidence: "Some people cannot actually bear to see a red candlestick." },
      ],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: null,
      scopeBasis: "VERIFIED_GLOBAL" as const, // incorrectly set upstream
    };
    expect(() => assertMasterChecklistSourcesGlobal([conditionalRule])).toThrow(SynthesisInvariantError);
  });
});

/**
 * Production incident fix — the FIRST real production synthesis failed at
 * the playbook stage with assertMasterChecklistSourcesGlobal throwing on a
 * rule ("Do not exit trades prematurely out of impatience during
 * consolidation; hold positions strictly until either the predefined
 * profit target or the stop loss is hit.", supportLevel=MULTI_SOURCE,
 * distinctLessons=1) that coreFramework.ts had itself just classified
 * VERIFIED_GLOBAL. Root cause: coreFramework.ts's buildRuleFromKeys checked
 * each cited KnowledgeItem's own `statement` text for positive-proof
 * language, while the backstop re-derived the same check from the rule's
 * FINAL emitted `sources`, each carrying a DIFFERENT text field
 * (`evidence`, the verbatim transcript quote) — a citation whose
 * `statement` paraphrase says "every trade" but whose quoted `evidence`
 * doesn't repeat that wording satisfies the first check and fails the
 * second. Fix: coreFramework.ts's buildRuleFromKeys now runs a SECOND,
 * source/evidence-based pass (scopeBasis.ts's
 * finalizeScopeBasisFromEmittedSources — the exact same helper the
 * backstop itself now calls) immediately after its existing statement-based
 * check, so a rule can only leave CoreFramework VERIFIED_GLOBAL once BOTH
 * checks agree. These tests reproduce the exact production failure shape
 * end-to-end through extractCoreFramework, prove the rule is downgraded
 * (never dropped) and excluded from the Master Trading Checklist, prove
 * synthesis no longer throws for it, and prove a genuinely-verified rule
 * (the course-wide 2R rule, with realistic matching evidence text) still
 * reaches VERIFIED_GLOBAL and the checklist.
 */
describe("Production incident — a rule's FINAL emitted sources/evidence, not just its citations' statement text, must independently satisfy the VERIFIED_GLOBAL positive-proof gate before CoreFramework ever marks it VERIFIED_GLOBAL", () => {
  async function buildCoreFrameworkFromSingleKnowledgeItem(item: ReturnType<typeof makeKnowledgeItem>) {
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [item], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "trade_management",
                  title: "Trade Management",
                  rules: [
                    {
                      description: "Do not exit trades prematurely out of impatience during consolidation; hold positions strictly until either the predefined profit target or the stop loss is hit.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 1,
                      sourceKeys: ["k1"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    return extractCoreFramework({ gemini, model: "m" }, [], [], [...normalized.globalItems, ...normalized.otherScopedItems]);
  }

  it("exact production failure shape: a MULTI_SOURCE rule with 1 distinct lesson, whose citation's `statement` carries positive-universal language but whose quoted `evidence` does not, ends up NOT VERIFIED_GLOBAL — never UNVERIFIED-crashing synthesis", async () => {
    // statement paraphrases the rule as unconditional ("every trade"), but the actual quoted
    // transcript evidence just describes the instructor's general point without that phrasing —
    // exactly the field mismatch the production incident hit.
    const item = makeKnowledgeItem({
      statement: "Hold every trade until the profit target or stop loss is hit — do not exit early out of impatience.",
      evidence: "Yeah, so during consolidation, you don't want to panic and close out early — just let it play out to target or stop.",
      scope: emptyScope(),
    });
    const { coreFramework } = await buildCoreFrameworkFromSingleKnowledgeItem(item);
    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scopeBasis).not.toBe("VERIFIED_GLOBAL");
    expect(rule.scopeBasis).toBe("UNVERIFIED");
    // The rule itself, its evidence, and its provenance are never dropped — only reclassified.
    expect(rule.description).toBe(
      "Do not exit trades prematurely out of impatience during consolidation; hold positions strictly until either the predefined profit target or the stop loss is hit.",
    );
    expect(rule.sources).toHaveLength(1);
    expect(rule.sources[0].lessonId).toBe(10);
  });

  it("the downgraded rule is excluded from selectVerifiedGlobalCoreFrameworkRules / the Master Trading Checklist source pool", async () => {
    const item = makeKnowledgeItem({
      statement: "Hold every trade until the profit target or stop loss is hit — do not exit early out of impatience.",
      evidence: "Just let it play out to target or stop, don't panic during consolidation.",
      scope: emptyScope(),
    });
    const { coreFramework } = await buildCoreFrameworkFromSingleKnowledgeItem(item);
    const { selectVerifiedGlobalCoreFrameworkRules, assertMasterChecklistSourcesGlobal, buildMasterTradingChecklistSection } = await import("../src/synthesis/runSynthesis.js");
    const verifiedGlobalRules = selectVerifiedGlobalCoreFrameworkRules(coreFramework);
    expect(verifiedGlobalRules).toHaveLength(0);
    // The now-correctly-typed selection never trips the backstop, and the checklist correctly
    // reports no genuinely course-wide principle was found rather than fabricating one.
    expect(() => assertMasterChecklistSourcesGlobal(verifiedGlobalRules)).not.toThrow();
    const section = buildMasterTradingChecklistSection(verifiedGlobalRules);
    expect(section.content).toContain("No genuinely course-wide");
  });

  it("full runSynthesis(...) does not throw SynthesisInvariantError for the exact production failure shape — synthesis completes instead of failing at the playbook stage", async () => {
    const item = makeKnowledgeItem({
      statement: "Hold every trade until the profit target or stop loss is hit — do not exit early out of impatience.",
      evidence: "Just let it play out to target or stop, don't panic during consolidation.",
      scope: emptyScope(),
    });
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [item], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const instance = makeInstance({ strategyInstanceId: 1, lessonId: 20, lessonTitle: "Break and Retest Lesson", strategyName: "Break and Retest", strategy: makeStrategy({ strategy_name: "Break and Retest" }) });

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) {
          return { text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break and Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }] }), usage };
        }
        if (prompt.includes("synthesizing ONE canonical trading strategy")) {
          return { text: rawCanonicalStrategyJson("Break and Retest"), usage };
        }
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "trade_management",
                  title: "Trade Management",
                  rules: [
                    {
                      description: "Do not exit trades prematurely out of impatience during consolidation; hold positions strictly until either the predefined profit target or the stop loss is hit.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 1,
                      sourceKeys: ["k1"],
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
        return { text: JSON.stringify({ nodes: [], readableSteps: [] }), usage };
      }),
    });

    const input: RunSynthesisInput = {
      courseTitle: "Trading Accelerator",
      instances: [instance],
      lessons: [
        { id: 20, title: "Break and Retest Lesson", chapterTitle: null, sourceUrl: "https://x" },
        { id: 10, title: "Lesson 10", chapterTitle: null, sourceUrl: "https://y" },
      ],
      noStandaloneSetupLessonIds: [],
      knowledgeSources,
    };
    const result = await runSynthesis({ gemini, model: "m" }, input);

    // The production-shape rule must have been downgraded and excluded from the checklist, not
    // silently dropped nor allowed to throw a SynthesisInvariantError partway through synthesis.
    const coreRule = result.coreFramework.sections.flatMap((s) => s.rules).find((r) => r.description.startsWith("Do not exit trades prematurely"));
    expect(coreRule).toBeDefined();
    expect(coreRule!.scopeBasis).not.toBe("VERIFIED_GLOBAL");
    const checklist = result.playbook.sections.find((s) => s.key === "master_trading_checklist");
    expect(checklist!.content).not.toContain("Do not exit trades prematurely");
  });

  it("proof: a genuinely verified rule (the course-wide 2R rule) whose evidence text ALSO independently satisfies the positive-proof gate remains VERIFIED_GLOBAL and eligible for the Master Trading Checklist", async () => {
    const item = makeKnowledgeItem({
      statement: "Whenever you're trading, target at least a two R multiple.",
      evidence: "Whenever you're trading, you always want to target at least a two R multiple — no exceptions.",
      scope: emptyScope(),
    });
    const { coreFramework } = await buildCoreFrameworkFromSingleKnowledgeItem(item);
    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scopeBasis).toBe("VERIFIED_GLOBAL");

    const { selectVerifiedGlobalCoreFrameworkRules, assertMasterChecklistSourcesGlobal, buildMasterTradingChecklistSection } = await import("../src/synthesis/runSynthesis.js");
    const verifiedGlobalRules = selectVerifiedGlobalCoreFrameworkRules(coreFramework);
    expect(verifiedGlobalRules).toHaveLength(1);
    expect(() => assertMasterChecklistSourcesGlobal(verifiedGlobalRules)).not.toThrow();
    const section = buildMasterTradingChecklistSection(verifiedGlobalRules);
    expect(section.content).toContain(rule.description);
  });
});

describe("Real-audit v4, Proof 2 — the 2R rule resolves from real evidence, never forced to scope:null", () => {
  it("a 2R rule cited from an options/beginner-scoped KnowledgeItem preserves that exact scope and SCOPED basis through CoreFramework", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.", scope: emptyScope({ marketsOrInstruments: ["options"], traderProfiles: ["beginner"] }) })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "risk", title: "Risk", rules: [{ description: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    // otherScopedItems (not globalItems) is what a real 2R-scoped item lands in — see knowledgeNormalize.ts.
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.otherScopedItems);

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scope).toEqual({ strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] });
    expect(rule.scopeBasis).toBe("SCOPED");
  });
});

describe("Real-audit v4, Proof 1 (decision framework) — an UNVERIFIED pre-strategy gate is caught the same way a scoped one is, and futures/forex strategies bypass it", () => {
  it("findGlobalGateScopeLeaks flags an UNVERIFIED node on the unconditional spine with reason 'unverified_source'", async () => {
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const badDecisionFramework = {
      nodes: [
        { id: "start", type: "start" as const, label: "Start", description: null, next: ["setup-qualification"], branches: [], sourceKeys: [], scope: emptyScope(), scopeBasis: "VERIFIED_GLOBAL" as const },
        {
          id: "setup-qualification",
          type: "action" as const,
          label: "Foundational Setup Qualification",
          description: "Evaluate Intraday Fundamentals and QQQ/SPY relative strength.",
          next: ["pick-strategy"],
          branches: [],
          sourceKeys: ["k1"],
          scope: emptyScope(),
          scopeBasis: "UNVERIFIED" as const,
        },
        { id: "pick-strategy", type: "decision" as const, label: "Which canonical strategy applies?", description: null, next: [], branches: [{ label: "Futures Trend Continuation", next: "futures-path" }], sourceKeys: [], scope: emptyScope(), scopeBasis: "VERIFIED_GLOBAL" as const },
        { id: "futures-path", type: "action" as const, label: "Futures Trend Continuation entry", description: null, next: [], branches: [], sourceKeys: [], scope: emptyScope(), scopeBasis: "VERIFIED_GLOBAL" as const },
      ],
      readableSteps: [],
      scopeLeaks: [],
    };

    const leaks = findGlobalGateScopeLeaks(badDecisionFramework as never);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ nodeId: "setup-qualification", reason: "unverified_source" });
  });

  it("synthesizeDecisionFramework end-to-end: a CoreFramework rule built from a legacy Intraday Fundamentals/QQQ-SPY citation cannot gate a futures strategy before selection unless global evidence actually supports it", async () => {
    const instance = makeInstance({
      strategy: makeStrategy({
        market_context_rules: [
          { description: "Confirm Intraday Fundamentals and QQQ/SPY relative strength/order flow.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" },
        ],
      }),
    });
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const coreFrameworkGemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          sections: [{ key: "setup", title: "Foundational Setup Qualification", rules: [{ description: "Evaluate Intraday Fundamentals and QQQ/SPY relative strength before any trade.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
        }),
        usage,
      })),
    });
    const { coreFramework } = await extractCoreFramework({ gemini: coreFrameworkGemini, model: "m" }, [], [instance]);
    // Confirms the upstream fix actually produced UNVERIFIED input for this test to be meaningful.
    expect(coreFramework.sections[0].rules[0].scopeBasis).toBe("UNVERIFIED");

    const decisionGemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["pick-strategy"], branches: [], sourceKeys: [] },
            {
              id: "pick-strategy",
              type: "decision",
              label: "Which canonical strategy applies?",
              description: null,
              next: [],
              branches: [
                { label: "Momentum Stock Breakout", next: "setup-qualification" },
                { label: "Futures Trend Continuation", next: "futures-path" },
              ],
              sourceKeys: [],
            },
            { id: "setup-qualification", type: "action", label: "Foundational Setup Qualification", description: null, next: ["stock-path"], branches: [], sourceKeys: ["k1"] },
            { id: "stock-path", type: "action", label: "Momentum Stock Breakout entry", description: null, next: [], branches: [], sourceKeys: [] },
            { id: "futures-path", type: "action", label: "Futures Trend Continuation entry", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: ["Pick strategy"],
        }),
        usage,
      })),
    });
    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const momentumStock = { name: "Momentum Stock Breakout", purpose: "p", markets: [], timeframes: [], marketContext: [], prerequisites: [], setup: [], entryRules: [], confirmationRules: [], stopLossRules: [], profitTargetRules: [], tradeManagementRules: [], invalidationRules: [], noTradeConditions: [], visualDiscretionaryRules: [], riskManagementRules: [], positionSizingRules: [], scalingInRules: [], scalingOutRules: [], runnerManagementRules: [], warnings: [], instructorPreferences: [], variants: [], examples: [], ambiguities: [], conflicts: [], sourceLessonIds: [], supportingKnowledgeLessonIds: [] };
    const futures = { ...momentumStock, name: "Futures Trend Continuation" };

    const { decisionFramework } = await synthesizeDecisionFramework({ gemini: decisionGemini, model: "m" }, [momentumStock as never, futures as never], coreFramework);

    // "Foundational Setup Qualification" sits behind the Momentum Stock Breakout branch specifically —
    // but it's STILL flagged, because an UNVERIFIED rule must never be trusted as an unconditional
    // gate even when correctly placed behind a branch is not itself required here: what matters is
    // that the futures path never routes through it at all.
    const byId = new Map(decisionFramework.nodes.map((n) => [n.id, n]));
    expect(byId.get("futures-path")).toBeDefined();
    expect(byId.get("setup-qualification")!.scopeBasis).toBe("UNVERIFIED");

    // If a future prompt revision ever placed this same UNVERIFIED node unconditionally before
    // strategy selection, the audit would catch it — proven directly here.
    const unconditionalPlacement = {
      nodes: [
        { ...decisionFramework.nodes.find((n) => n.id === "start")!, next: ["setup-qualification"] },
        { ...byId.get("setup-qualification")!, next: ["pick-strategy"] },
        { ...byId.get("pick-strategy")!, next: [], sourceKeys: [] },
      ],
      readableSteps: [],
      scopeLeaks: [],
    };
    const { findGlobalGateScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const leaks = findGlobalGateScopeLeaks(unconditionalPlacement as never);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].reason).toBe("unverified_source");
  });
});

/**
 * Real-audit v9, Part 3 — decisionScopeAudit.ts's findReadableStepScopeLeaks
 * extends the existing decision-framework scope-fidelity audit to also
 * validate `readableSteps` (previously audited ONLY at the node level, per
 * findGlobalGateScopeLeaks above), catching real scope broadening that lived
 * entirely in the plain-text fallback walkthrough while decisionFramework.
 * scopeLeaks read 0. Uses the exact real Step 5/Step 8 wording quoted from
 * the latest real-data audit.
 */
describe("Real-audit v9, Part 3 — findReadableStepScopeLeaks catches real scope broadening in readableSteps that the node-level audit misses entirely", () => {
  it("real failure: Step 5 — 'Evaluate the specific setup's rules: verify boundary break and displacement, require a clean pullback/retest of flipped structure, confirm...candle body closures, and verify relative strength...' is flagged — retest entry, candle-close confirmation, and relative-strength confirmation are NOT universal across every canonical strategy", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const nonGlobalRules = [
      {
        description: "Require a clean pullback/retest of the flipped structure, confirm the setup with candle body closures, and verify relative strength before entering.",
        basis: "SCOPED" as const,
      },
    ];
    const leaks = findReadableStepScopeLeaks(
      [
        "Evaluate the specific setup's rules: verify boundary break and displacement, require a clean pullback/retest of flipped structure, confirm the setup with candle body closures, and verify relative strength before entering.",
      ],
      nonGlobalRules,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ stepIndex: 0, reason: "scoped_mechanic" });
    expect(leaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });

  it("real failure: Step 8 — 'Scale out partial profits at the initial structural target (such as HOD/LOD or pre-market extremes) and trail runners...' is flagged — HOD/LOD-target scaling and trailing runners are scoped intraday/momentum trade-management mechanics, not universal exit behavior", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const nonGlobalRules = [
      {
        description: "Scale out partial profits at the initial structural target such as HOD/LOD or pre-market extremes and trail runners on the remaining position.",
        basis: "UNVERIFIED" as const,
      },
    ];
    const leaks = findReadableStepScopeLeaks(
      ["Scale out partial profits at the initial structural target (such as HOD/LOD or pre-market extremes) and trail runners on the remaining position."],
      nonGlobalRules,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatchObject({ stepIndex: 0, reason: "unverified_mechanic" });
  });

  it("both real failures found together in a realistic multi-step walkthrough, with the correctly-global steps around them left unflagged", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const nonGlobalRules = [
      { description: "Require a clean pullback/retest of the flipped structure, confirm the setup with candle body closures, and verify relative strength before entering.", basis: "SCOPED" as const },
      { description: "Scale out partial profits at the initial structural target such as HOD/LOD or pre-market extremes and trail runners on the remaining position.", basis: "UNVERIFIED" as const },
    ];
    const steps = [
      "Determine the higher-timeframe context and market regime before looking for a setup.",
      "Identify key levels the market is likely to react to.",
      "Determine which canonical strategy, if any, applies to the current setup.",
      "Evaluate the specific setup's rules: verify boundary break and displacement, require a clean pullback/retest of flipped structure, confirm the setup with candle body closures, and verify relative strength before entering.",
      "Define the invalidation level and initial stop-loss before entering.",
      "Scale out partial profits at the initial structural target (such as HOD/LOD or pre-market extremes) and trail runners on the remaining position.",
    ];
    const leaks = findReadableStepScopeLeaks(steps, nonGlobalRules);
    expect(leaks.map((l) => l.stepIndex)).toEqual([3, 5]);
  });

  it("preferred safe wording (entry/confirmation deferral) is NOT flagged: 'Apply the selected canonical strategy's own prerequisites, entry, confirmation, invalidation and no-trade rules, including its documented exceptions.'", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const nonGlobalRules = [
      { description: "Require a clean pullback/retest of the flipped structure, confirm the setup with candle body closures, and verify relative strength before entering.", basis: "SCOPED" as const },
    ];
    const leaks = findReadableStepScopeLeaks(
      ["Apply the selected canonical strategy's own prerequisites, entry, confirmation, invalidation and no-trade rules, including its documented exceptions."],
      nonGlobalRules,
    );
    expect(leaks).toEqual([]);
  });

  it("preferred safe wording (exit/trade-management deferral) is NOT flagged even though it names the exact scoped mechanics from a SCOPED rule, because it defers to the selected strategy: 'Apply the selected strategy's own target and trade-management rules; use HOD/LOD scaling, runners, fixed-R exits, gap-fill targets, etc. only where that strategy specifies them.'", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const nonGlobalRules = [
      { description: "Scale out partial profits at the initial structural target such as HOD/LOD or pre-market extremes and trail runners on the remaining position.", basis: "UNVERIFIED" as const },
    ];
    const leaks = findReadableStepScopeLeaks(
      ["Apply the selected strategy's own target and trade-management rules; use HOD/LOD scaling, runners, fixed-R exits, gap-fill targets, etc. only where that strategy specifies them."],
      nonGlobalRules,
    );
    expect(leaks).toEqual([]);
  });

  it("a step with no matching non-global rule at all (genuinely global mechanic, e.g. defining an invalidation level) is never flagged, even with no deferral wording", async () => {
    const { findReadableStepScopeLeaks } = await import("../src/synthesis/decisionScopeAudit.js");
    const leaks = findReadableStepScopeLeaks(["Define the invalidation level and initial stop-loss before entering any trade."], []);
    expect(leaks).toEqual([]);
  });

  it("synthesizeDecisionFramework end-to-end: readableStepLeaks is populated on the returned DecisionFramework and participates in the same object the PASS/FAIL gate reads, using a real Step 5-shaped readable step and a matching SCOPED CoreFramework rule", async () => {
    const { synthesizeDecisionFramework } = await import("../src/synthesis/decisionFramework.js");
    const coreFramework = {
      sections: [
        {
          key: "entry_framework",
          title: "Entry Framework",
          rules: [
            {
              description: "Require a clean pullback/retest of the flipped structure and confirm with candle body closures before entering.",
              classification: "explicit" as const,
              supportLevel: "SINGLE_SOURCE" as const,
              supportCount: 1,
              sources: [{ lessonId: 1, lessonTitle: "Lesson 1", evidence: "e" }],
              conflictSources: [],
              scope: emptyScope({ strategies: ["Trendline Break"] }),
              scopeBasis: "SCOPED" as const,
            },
          ],
        },
      ],
    };
    const canonicalStrategies: unknown[] = [];
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          nodes: [
            { id: "start", type: "start", label: "Start", description: null, next: ["end"], branches: [], sourceKeys: [] },
            { id: "end", type: "end", label: "End", description: null, next: [], branches: [], sourceKeys: [] },
          ],
          readableSteps: [
            "Evaluate the specific setup's rules: require a clean pullback/retest of the flipped structure and confirm with candle body closures before entering.",
          ],
        }),
        usage,
      })),
    });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, canonicalStrategies as never, coreFramework as never);
    expect(decisionFramework.readableStepLeaks).toHaveLength(1);
    expect(decisionFramework.readableStepLeaks[0].reason).toBe("scoped_mechanic");
  });
});

describe("Real-audit v5, Proof 3 — a correctly constructed playbook produces zero applicability leaks across all three categories despite real scoped/unverified underlying data", () => {
  it("a playbook that precisely qualifies its scoped/unverified material (never absolute language outside its declared scope) produces zero leaks in any category", async () => {
    const scopeVocabulary = new Set(["options", "beginner"]);
    const nonGlobalRules: import("../src/synthesis/frameworkScopeSplit.js").TaggedNonGlobalRule[] = [
      { description: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.", basis: "SCOPED" },
      { description: "Confirm Intraday Fundamentals and QQQ/SPY relative strength/order flow.", basis: "UNVERIFIED" },
    ];
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");

    const wellBehavedSections = [
      {
        key: "risk_management",
        content: "As a baseline, define your risk before entry. For options traders who are beginners, a minimum 2:1 reward-to-risk ratio is typically enforced.",
        scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] },
        scopeBasis: "SCOPED" as const,
        applicabilityPolicy: "DESCRIPTIVE_MIXED" as const,
      },
      {
        key: "master_trading_checklist",
        content: "Always define your risk before entry and confirm the higher-timeframe context — these hold for every strategy in this course.",
        scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
        scopeBasis: "VERIFIED_GLOBAL" as const,
        applicabilityPolicy: "VERIFIED_GLOBAL_ONLY" as const,
      },
      {
        key: "scoped_execution_checklists",
        content:
          "Intraday Equities/Options Checklist (applies only to intraday options trades): confirm Intraday Fundamentals and QQQ/SPY relative strength before entering a Momentum Stock Breakout trade.",
        scope: { strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: [] },
        scopeBasis: "SCOPED" as const,
        applicabilityPolicy: "SCOPED" as const,
      },
    ];

    const result = findPlaybookApplicabilityLeaks(wellBehavedSections, scopeVocabulary, nonGlobalRules);
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
    expect(result.scopedApplicabilityLeaks).toEqual([]);
  });
});

describe("Real-audit v5, Proof 2 (continued) — a VERIFIED_GLOBAL rule survives partitioning even alongside SCOPED corroboration (the exact 2R real-audit failure, with both evidence classes present at once)", () => {
  it("citing a genuinely global knowledge item AND a scoped one on the SAME Gemini-authored rule produces a VERIFIED_GLOBAL rule (independently sufficient) plus a separate SCOPED corroborating rule — the global evidence is never narrowed away", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [
            // k1 — genuinely global: general expectancy/trade-management teaching with no restriction.
            // evidence carries the same positive-universal wording as statement (a real
            // transcript quote and its extracted paraphrase typically agree) — production
            // incident fix: the final VERIFIED_GLOBAL gate now ALSO re-checks each source's own
            // `evidence` text (see scopeBasis.ts's finalizeScopeBasisFromEmittedSources), not just
            // the KnowledgeItem's `statement`, so a fixture's evidence must be realistic too.
            makeKnowledgeItem({
              statement: "Whenever you're trading, target at least a two R multiple.",
              evidence: "Whenever you're trading, you want to target at least a two R multiple.",
              scope: emptyScope(),
            }),
            // k2 — scoped corroboration: the SAME principle, options/beginner-specific.
            makeKnowledgeItem({ statement: "Beginners trading options should target at least a two R multiple.", scope: emptyScope({ marketsOrInstruments: ["options"], traderProfiles: ["beginner"] }) }),
          ],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [
                {
                  key: "risk",
                  title: "Risk",
                  rules: [
                    {
                      description: "Structure trades to target a minimum reward-to-risk ratio of at least 2:1.",
                      classification: "explicit",
                      supportLevel: "MULTI_SOURCE",
                      supportCount: 2,
                      sourceKeys: ["k1", "k2"], // Gemini cites BOTH global and scoped evidence on one rule — the exact real-audit failure.
                      conflictSourceKeys: [],
                    },
                  ],
                },
              ],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    // otherScopedItems carries k2 (options/beginner-scoped); globalItems carries k1 — both pooled, in that order, by extractCoreFramework's buildKeyedPool.
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], [...normalized.globalItems, ...normalized.otherScopedItems]);

    const rules = coreFramework.sections[0].rules;
    expect(rules).toHaveLength(2);
    const globalRule = rules.find((r) => r.scopeBasis === "VERIFIED_GLOBAL");
    const scopedRule = rules.find((r) => r.scopeBasis === "SCOPED");
    expect(globalRule).toBeDefined();
    expect(scopedRule).toBeDefined();
    expect(globalRule!.scope).toBeNull();
    expect(scopedRule!.scope).toEqual({ strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] });
  });

  it("when only SCOPED evidence exists (no independent global support), the rule stays SCOPED — never promoted to VERIFIED_GLOBAL just because it's the only evidence available", async () => {
    const knowledgeSources: LessonKnowledgeSource[] = [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Lesson 10",
        knowledge: {
          summary: "s",
          knowledgeItems: [makeKnowledgeItem({ statement: "Beginners trading options should target at least a two R multiple.", scope: emptyScope({ marketsOrInstruments: ["options"], traderProfiles: ["beginner"] }) })],
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "risk", title: "Risk", rules: [{ description: "Target at least a 2:1 reward-to-risk ratio.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });

    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [], normalized.otherScopedItems);

    const rules = coreFramework.sections[0].rules;
    expect(rules).toHaveLength(1);
    expect(rules[0].scopeBasis).toBe("SCOPED");
    expect(rules[0].scope).toEqual({ strategies: [], marketsOrInstruments: ["options"], timeframes: [], sessions: [], traderProfiles: ["beginner"] });
  });
});

describe("Real-audit v5, Blocker 1 — deterministic cluster-merge guard makes canonical identity stable across runs over unchanged source analyses", () => {
  function makeSignature(overrides: Partial<import("../src/synthesis/normalize.js").StrategySignature>): import("../src/synthesis/normalize.js").StrategySignature {
    return {
      strategyInstanceId: 1,
      lessonId: 1,
      lessonTitle: "Lesson",
      originalName: "Strategy",
      normalizedName: "strategy",
      markets: ["ES"],
      timeframes: ["5m"],
      indicators: [],
      ruleCounts: {
        setup_conditions: 1,
        entry_rules: 1,
        confirmation_rules: 1,
        stop_loss_rules: 1,
        profit_target_rules: 1,
        trade_management_rules: 1,
        invalidation_rules: 1,
        no_trade_conditions: 0,
        market_context_rules: 1,
        visual_discretionary_rules: 0,
      },
      entrySummary: "e",
      ...overrides,
    };
  }

  it("Regression A: a foundational horizontal Break & Retest (instance 11) and a Top-Down Multi-Timeframe Break & Retest (instance 19) — materially different timeframe hierarchy AND rule shape — remain SEPARATE canonical strategies even when Gemini merges them into one cluster", async () => {
    const { applyClusterMergeGuard } = await import("../src/synthesis/clusterMergeGuard.js");
    const br = makeSignature({ strategyInstanceId: 11, originalName: "Break and Retest (B&R) Setup", timeframes: ["5m"] });
    const topDown = makeSignature({
      strategyInstanceId: 19,
      originalName: "Top-Down Multi-Timeframe Break and Retest",
      timeframes: ["1H", "5m"], // a genuine multi-timeframe hierarchy, not a single-timeframe substitution
      ruleCounts: { ...br.ruleCounts, setup_conditions: 4, confirmation_rules: 4, market_context_rules: 4 }, // mandatory top-down context/confirmation steps added
    });

    const geminiMergedCluster = [
      { clusterKey: "br-multi", proposedCanonicalName: "Multi-Timeframe Break and Retest Strategy", memberInstanceIds: [11, 19], similarityRationale: "same break/retest mechanics", differencesNotes: "one adds HTF context" },
    ];

    const guarded = applyClusterMergeGuard(geminiMergedCluster, [br, topDown]);
    expect(guarded).toHaveLength(2);
    expect(guarded.map((c) => c.memberInstanceIds)).toEqual(expect.arrayContaining([[11], [19]]));
  });

  it("Regression B: a 1-minute ORB and a 5-minute systematic ORB variant — same single-timeframe shape, same rule shape — remain ONE merged canonical strategy", async () => {
    const { applyClusterMergeGuard } = await import("../src/synthesis/clusterMergeGuard.js");
    const orb1m = makeSignature({ strategyInstanceId: 21, originalName: "1-Minute ORB", timeframes: ["1m"] });
    const orb5m = makeSignature({ strategyInstanceId: 22, originalName: "5-Minute Systematic ORB", timeframes: ["5m"] }); // same ruleCounts shape as orb1m — only the traded timeframe differs

    const geminiMergedCluster = [
      { clusterKey: "orb", proposedCanonicalName: "Opening Range Breakout", memberInstanceIds: [21, 22], similarityRationale: "same ORB mechanics, different timeframe", differencesNotes: "" },
    ];

    const guarded = applyClusterMergeGuard(geminiMergedCluster, [orb1m, orb5m]);
    expect(guarded).toHaveLength(1);
    expect(guarded[0].memberInstanceIds.sort()).toEqual([21, 22]);
  });

  it("Regression C (v7): a real-shape foundational B&R (11) vs Top-Down Multi-Timeframe B&R (19) pair whose rule-count differences are spread THINLY across several categories (+1 each, never reaching the old >=2-per-category bar) — the exact real dry-run failure that produced 15 clusters instead of 16 — still SPLITS apart", async () => {
    const { applyClusterMergeGuard } = await import("../src/synthesis/clusterMergeGuard.js");
    const br = makeSignature({ strategyInstanceId: 11, originalName: "Break and Retest (B&R) Setup", timeframes: ["5m"] });
    const topDown = makeSignature({
      strategyInstanceId: 19,
      originalName: "Top-Down Multi-Timeframe Break and Retest",
      timeframes: ["1H", "5m"],
      // Every diff below is exactly +1 — under the OLD dual-threshold logic (>=2 count
      // difference in >=2 categories) NONE of these categories would have counted, so
      // hasRuleShapeDivergence would have been false and this pair would have stayed
      // merged even with the genuine timeframe-hierarchy mismatch present.
      ruleCounts: {
        ...br.ruleCounts,
        setup_conditions: br.ruleCounts.setup_conditions + 1,
        confirmation_rules: br.ruleCounts.confirmation_rules + 1,
        market_context_rules: br.ruleCounts.market_context_rules + 1,
        trade_management_rules: br.ruleCounts.trade_management_rules + 1,
      },
    });

    const geminiMergedCluster = [
      { clusterKey: "br-multi", proposedCanonicalName: "Multi-Timeframe Break and Retest Strategy", memberInstanceIds: [11, 19], similarityRationale: "same break/retest mechanics", differencesNotes: "one adds HTF context" },
    ];

    const guarded = applyClusterMergeGuard(geminiMergedCluster, [br, topDown]);
    expect(guarded).toHaveLength(2);
    expect(guarded.map((c) => c.memberInstanceIds)).toEqual(expect.arrayContaining([[11], [19]]));
  });

  it("Regression D (v7): ORB 22 + ORB 27 with a couple of harmless one-off rule-count differences (ordinary lesson-to-lesson wording variance, spread across too few categories to be a real shape change) remain ONE merged canonical strategy — the new distributed-divergence signal does not over-trigger on modest noise", async () => {
    const { applyClusterMergeGuard } = await import("../src/synthesis/clusterMergeGuard.js");
    const orb22 = makeSignature({ strategyInstanceId: 22, originalName: "Opening Range Breakout", timeframes: ["5m"] });
    const orb27 = makeSignature({
      strategyInstanceId: 27,
      originalName: "Opening Range Breakout (Systematic)",
      timeframes: ["5m"],
      // Only 2 categories move, each by 1 — below MIN_DISTRIBUTED_CATEGORIES (3), so this
      // never reaches the distributed-divergence branch either, exactly like the
      // concentrated branch's existing single-off-by-one tolerance.
      ruleCounts: { ...orb22.ruleCounts, confirmation_rules: orb22.ruleCounts.confirmation_rules + 1, stop_loss_rules: orb22.ruleCounts.stop_loss_rules + 1 },
    });

    const geminiMergedCluster = [
      { clusterKey: "orb", proposedCanonicalName: "Opening Range Breakout", memberInstanceIds: [22, 27], similarityRationale: "same ORB mechanics", differencesNotes: "" },
    ];

    const guarded = applyClusterMergeGuard(geminiMergedCluster, [orb22, orb27]);
    expect(guarded).toHaveLength(1);
    expect(guarded[0].memberInstanceIds.sort()).toEqual([22, 27]);
  });

  it("stability: identical source signatures produce the SAME final canonical membership structure regardless of whether Gemini's raw clustering call happens to merge or split B&R/Top-Down B&R", async () => {
    const { applyClusterMergeGuard } = await import("../src/synthesis/clusterMergeGuard.js");
    const br = makeSignature({ strategyInstanceId: 11, originalName: "Break and Retest (B&R) Setup", timeframes: ["5m"] });
    const topDown = makeSignature({
      strategyInstanceId: 19,
      originalName: "Top-Down Multi-Timeframe Break and Retest",
      timeframes: ["1H", "5m"],
      ruleCounts: { ...br.ruleCounts, setup_conditions: 4, confirmation_rules: 4, market_context_rules: 4 },
    });

    // Run A: Gemini happens to merge them (as the real dry run that produced 15 did).
    const runAMerged = applyClusterMergeGuard(
      [{ clusterKey: "br-multi", proposedCanonicalName: "Multi-Timeframe Break and Retest Strategy", memberInstanceIds: [11, 19], similarityRationale: "r", differencesNotes: "" }],
      [br, topDown],
    );
    // Run B: Gemini happens to keep them separate (as the previously-accepted run that produced 16 did).
    const runBSeparate = applyClusterMergeGuard(
      [
        { clusterKey: "br", proposedCanonicalName: "Break and Retest (B&R) Setup", memberInstanceIds: [11], similarityRationale: "r", differencesNotes: "" },
        { clusterKey: "td-br", proposedCanonicalName: "Top-Down Multi-Timeframe Break and Retest", memberInstanceIds: [19], similarityRationale: "r", differencesNotes: "" },
      ],
      [br, topDown],
    );

    const membershipOf = (clusters: { memberInstanceIds: number[] }[]) => clusters.map((c) => [...c.memberInstanceIds].sort()).sort();
    expect(membershipOf(runAMerged)).toEqual(membershipOf(runBSeparate));
    expect(membershipOf(runAMerged)).toEqual([[11], [19]]);
  });

  it("clusterStrategyInstances (end-to-end, real Gemini call path) applies the guard automatically — a Gemini response merging B&R/Top-Down B&R is still split apart in the final result", async () => {
    const br = makeInstance({ strategyInstanceId: 11, lessonId: 11, strategyName: "Break and Retest (B&R) Setup", strategy: makeStrategy({ strategy_name: "Break and Retest (B&R) Setup", timeframes: ["5m"] }) });
    const topDown = makeInstance({
      strategyInstanceId: 19,
      lessonId: 19,
      strategyName: "Top-Down Multi-Timeframe Break and Retest",
      strategy: makeStrategy({
        strategy_name: "Top-Down Multi-Timeframe Break and Retest",
        timeframes: ["1H", "5m"],
        setup_conditions: [{ description: "HTF alignment 1", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "HTF alignment 2", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "HTF alignment 3", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "HTF alignment 4", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
        confirmation_rules: [{ description: "c1", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "c2", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "c3", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }, { description: "c4", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }],
      }),
    });
    const { buildStrategySignature } = await import("../src/synthesis/normalize.js");
    const signatures = [buildStrategySignature(br), buildStrategySignature(topDown)];

    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          clusters: [{ clusterKey: "br-multi", proposedCanonicalName: "Multi-Timeframe Break and Retest Strategy", memberInstanceIds: [11, 19], similarityRationale: "r", differencesNotes: "" }],
        }),
        usage,
      })),
    });

    const { clusterStrategyInstances } = await import("../src/synthesis/cluster.js");
    const { clusters } = await clusterStrategyInstances({ gemini, model: "m" }, signatures);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.memberInstanceIds)).toEqual(expect.arrayContaining([[11], [19]]));
  });
});
