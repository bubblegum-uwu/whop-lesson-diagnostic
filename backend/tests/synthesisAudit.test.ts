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
                    { description: "Always define risk before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sourceKeys: ["k1"], conflictSourceKeys: [] },
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
          // k1 (global, pooled first) backs "Always define risk before entry."; k2 (scoped) backs the market-open/options rule.
          knowledgeItems: [
            makeKnowledgeItem({ statement: "Always define risk before entry.", scope: emptyScope() }),
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
    expect(checklist.content).toContain("Always define risk before entry.");
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
    const verifiedGlobalRule = { ...scopedRule, description: "genuinely global", scope: null, scopeBasis: "VERIFIED_GLOBAL" as const };

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

  it("DESCRIPTIVE_MIXED policy (e.g. risk_management): a section whose OWN derived scopeBasis is SCOPED, using absolute-claim language, is a universalApplicabilityLeak — the primary provenance signal, independent of vocabulary/word-overlap", async () => {
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
      new Set(), // deliberately empty — proves this fires from provenance (scopeBasis), not vocabulary
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].sectionKey).toBe("risk_management");
  });

  it("DESCRIPTIVE_MIXED policy: a section whose OWN derived scopeBasis is UNVERIFIED, using absolute-claim language, is an unverifiedUniversalClaim (not a universalApplicabilityLeak)", async () => {
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
    expect(result.unverifiedUniversalClaims).toHaveLength(1);
    expect(result.unverifiedUniversalClaims[0].sectionKey).toBe("market_context_regime");
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

  it("real-audit fix (v6), do-not-weaken check: DESCRIPTIVE_MIXED strategy_variants with ownBasis SCOPED that does NOT name its own declared scope anywhere in the prose IS still flagged — the suppression only applies when the section actually discloses its own scope", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
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
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].sectionKey).toBe("strategy_variants");
  });

  it("real-audit fix (v6), do-not-weaken check: a strategy_variants section naming its OWN parent strategy is still flagged when it separately overlaps a DIFFERENT, undisclosed non-global rule's text (matchedScopedRules is untouched by the ownBasis suppression)", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Wait for the 84% re-entry confirmation before adding to a runner position.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "strategy_variants",
          content: "For the Inside Bar strategy: always wait for the 84% re-entry confirmation before adding to a runner position on every trade.",
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
 * SIXTH real-data audit regression tests (Phase 3.5B v7) — see PR #13's
 * sixth real 28-lesson dry-run audit. Four DESCRIPTIVE_MIXED sections
 * (key_levels, setup_selection, risk_management, target_selection) were
 * false-positive-flagged for the same underlying reason: each mixes a
 * genuinely VERIFIED_GLOBAL rule with properly-qualified SCOPED material,
 * and combineScopeBasis's "SCOPED dominates" priority (correct for the
 * union `scope` itself) made the section's AGGREGATE `scopeBasis` read
 * "SCOPED" even though the specific absolute claim in question is
 * independently globally backed. `hasIndependentGlobalEvidence` (see
 * PlaybookSectionSchema) lets the audit tell that apart from a section with
 * NO global partition at all. One real leak (market_context_regime) must
 * remain caught throughout.
 */
describe("Real-audit v7 — DESCRIPTIVE_MIXED sections mixing genuinely global evidence with properly-qualified scoped material are not false-positive-flagged", () => {
  it("real false positive: key_levels — the polarity-inversion claim has independent VERIFIED_GLOBAL evidence; unrelated, properly-qualified SCOPED chase/stop rules do not universalize the section", async () => {
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
          scopeBasis: "SCOPED", // combineScopeBasis: SCOPED dominates once ANY citation is scoped, even with an independently-global one also present
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
          hasIndependentGlobalEvidence: true, // the polarity-inversion citation is independently VERIFIED_GLOBAL
        },
      ],
      new Set(["options", "scalper"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: setup_selection — the narrow-specialization claim has independent VERIFIED_GLOBAL evidence; beginner/experienced counts are explicitly qualified in prose", async () => {
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
          hasIndependentGlobalEvidence: true,
        },
      ],
      new Set(["beginner", "experienced"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: risk_management — the 2R claim has genuine independent VERIFIED_GLOBAL evidence; beginner/options/scalping rules are explicitly labeled as such in prose", async () => {
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
          hasIndependentGlobalEvidence: true,
        },
      ],
      new Set(["options", "beginner", "scalper"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real false positive: target_selection — the section describes alternative target categories, explicitly labeling intraday/premarket/Gap Fill/Fibonacci/daily-weekly contexts; it never claims every target type applies to every strategy", async () => {
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
          hasIndependentGlobalEvidence: false, // this section has no independent global partition at all — every claim is locally qualified instead
        },
      ],
      new Set(["premarket", "daily", "weekly", "intraday"]),
    );
    expect(result.universalApplicabilityLeaks).toEqual([]);
    expect(result.unverifiedUniversalClaims).toEqual([]);
  });

  it("real leak preserved: market_context_regime — 'Directional trades must align with the prevailing higher-timeframe trend.' rests on SCOPED/UNVERIFIED evidence and is still flagged, even though the section's other statements (broad US equity indices..., active intraday momentum trading 9:30-11:00...) are properly qualified", async () => {
    const { findPlaybookApplicabilityLeaks } = await import("../src/synthesis/playbookApplicabilityAudit.js");
    const nonGlobalRules = [{ description: "Directional bias should align with the higher-timeframe trend before entry.", basis: "SCOPED" as const }];
    const result = findPlaybookApplicabilityLeaks(
      [
        {
          key: "market_context_regime",
          content:
            "Directional trades must align with the prevailing higher-timeframe trend. " +
            "Broad US equity indices always confirm the regime before any directional bias is taken. " +
            "Active intraday momentum trading between 9:30 AM and 11:00 AM always requires a confirmed regime read.",
          scope: { strategies: [], marketsOrInstruments: ["equities"], timeframes: [], sessions: ["9:30-11:00"], traderProfiles: [] },
          scopeBasis: "SCOPED",
          applicabilityPolicy: "DESCRIPTIVE_MIXED",
          hasIndependentGlobalEvidence: false, // no independently-global partition backs this section at all
        },
      ],
      new Set(["equities", "9:30-11:00"]),
      nonGlobalRules,
    );
    expect(result.universalApplicabilityLeaks).toHaveLength(1);
    expect(result.universalApplicabilityLeaks[0].sectionKey).toBe("market_context_regime");
    expect(result.universalApplicabilityLeaks[0].matchedNonGlobalRules).toEqual([nonGlobalRules[0].description]);
  });

  it("do-not-weaken check: a section WITH independent global evidence is still flagged when its scoped material is genuinely paraphrased as universal (matchedScopedRules stays fully sensitive — hasIndependentGlobalEvidence only suppresses the coarse sentence-level/ownBasis signals, never the precise per-rule overlap check)", async () => {
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
          hasIndependentGlobalEvidence: true, // the 2R half of this claim IS independently global — but that must not launder the erased 1%-risk restriction
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

  it("playbook.ts's enrichSection computes hasIndependentGlobalEvidence=true for a section citing both a VERIFIED_GLOBAL and a SCOPED pool entry, and false for a section citing only SCOPED/UNVERIFIED entries", async () => {
    const { extractCoreFramework } = await import("../src/synthesis/coreFramework.js");
    const knowledgeSources: LessonKnowledgeSource[] = [
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk before entering a trade.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);
    const instance = makeInstance({
      strategy: makeStrategy({ market_context_rules: [{ description: "Confirm order flow context.", classification: "explicit", confidence: 0.9, start_timestamp: "0:00", end_timestamp: null, evidence: "e" }] }),
    });
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "mixed", title: "Mixed", rules: [{ description: "Confirm order flow context and always define your risk.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 2, sourceKeys: ["k1", "k2"], conflictSourceKeys: [] }] }],
            }),
            usage,
          };
        }
        return { text: "{}", usage };
      }),
    });
    const { coreFramework } = await extractCoreFramework({ gemini, model: "m" }, [], [instance], normalized.globalItems);
    // enrichAndPartitionRule splits this into 2 rules (VERIFIED_GLOBAL + UNVERIFIED) since the two citations are different evidence classes.
    const rules = coreFramework.sections[0].rules;
    expect(rules.some((r) => r.scopeBasis === "VERIFIED_GLOBAL")).toBe(true);

    const { buildSynthesisSourcePool, combineScopeBasis, resolveSourcePoolKeys } = await import("../src/synthesis/synthesisSourcePool.js");
    const { poolEntries, byKey } = buildSynthesisSourcePool([], coreFramework);
    const allKeys = poolEntries.map((e) => e.key);
    const resolved = resolveSourcePoolKeys(allKeys, byKey);
    const hasIndependentGlobalEvidence = resolved.some((e) => e.scopeBasis === "VERIFIED_GLOBAL");
    expect(hasIndependentGlobalEvidence).toBe(true);
    expect(combineScopeBasis(resolved).scopeBasis).toBe("UNVERIFIED"); // aggregate is dragged down by the UNVERIFIED partition — hasIndependentGlobalEvidence is what preserves the distinction
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
        knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk before entering a trade.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] },
      },
    ];
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          return {
            text: JSON.stringify({
              sections: [{ key: "risk", title: "Risk", rules: [{ description: "Always define your risk before entering a trade.", classification: "explicit", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["k1"], conflictSourceKeys: [] }] }],
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
      { analysisId: 1, lessonId: 10, lessonTitle: "Lesson 10", knowledge: { summary: "s", knowledgeItems: [makeKnowledgeItem({ statement: "Always define your risk before entering a trade.", scope: emptyScope() })], examples: [], conflictsAndAmbiguities: [] } },
    ];
    const { normalizeLessonKnowledge } = await import("../src/synthesis/knowledgeNormalize.js");
    const normalized = normalizeLessonKnowledge(knowledgeSources);

    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) {
          // k1 = the market_context_rules legacy entry (pooled first), k2 = the global KnowledgeItem.
          return {
            text: JSON.stringify({
              sections: [{ key: "setup", title: "Setup", rules: [{ description: "Confirm relative strength and order flow alignment and always define your risk.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 2, sourceKeys: ["k1", "k2"], conflictSourceKeys: [] }] }],
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
    expect(globalRule!.description).toBe("Confirm relative strength and order flow alignment and always define your risk.");
    expect(unverifiedRule!.description).toBe("Confirm relative strength and order flow alignment and always define your risk.");
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
    expect(finalizeScopeBasis("VERIFIED_GLOBAL", "Always define your risk before entry.", undefined)).toBe("VERIFIED_GLOBAL");
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

  it("Master Checklist invariant (v7): a genuinely unrestricted VERIFIED_GLOBAL rule passes the independent re-check without throwing", async () => {
    const { assertMasterChecklistSourcesGlobal } = await import("../src/synthesis/runSynthesis.js");
    const genuineRule = {
      description: "Always define your risk before entering a trade.",
      classification: "explicit" as const,
      supportLevel: "MULTI_SOURCE" as const,
      supportCount: 2,
      sources: [],
      conflictSources: [],
      exceptions: [],
      numericalValues: [],
      scope: null,
      scopeBasis: "VERIFIED_GLOBAL" as const,
    };
    expect(() => assertMasterChecklistSourcesGlobal([genuineRule])).not.toThrow();
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
            makeKnowledgeItem({ statement: "Whenever you're trading, target at least a two R multiple.", scope: emptyScope() }),
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
