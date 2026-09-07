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

describe("Real-audit Blocker B — 'master_trading_checklist' can no longer be built from scoped/intraday-only material; scoped content routes to 'scoped_execution_checklists' instead", () => {
  it("shows Gemini ONLY genuinely-global core framework material for master_trading_checklist; the 9:30-11 AM/options-scoped rule appears only in the scoped_execution_checklists material", async () => {
    const { synthesizePlaybook } = await import("../src/synthesis/playbook.js");
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: JSON.stringify({ title: "P", sections: [], conflictsAndAmbiguities: [] }), usage };
      }),
    });

    const coreFramework = {
      sections: [
        {
          key: "risk",
          title: "Risk",
          rules: [
            { description: "Always define risk before entry.", classification: "explicit", supportLevel: "MULTI_SOURCE", supportCount: 3, sources: [], conflictSources: [], exceptions: [], numericalValues: [], scope: null },
            {
              description: "Trade only 9:30-11:00 AM ET, liquid mega-cap stocks with options volume.",
              classification: "explicit",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sources: [],
              conflictSources: [],
              exceptions: [],
              numericalValues: [],
              scope: { strategies: [], marketsOrInstruments: ["options", "stocks"], timeframes: ["1m", "5m"], sessions: ["market-open"], traderProfiles: [] },
            },
          ],
        },
      ],
    };
    const strategy = fullCanonicalStrategyV3({ name: "Strategy" });

    await synthesizePlaybook({ gemini, model: "m" }, "Trading Accelerator", [strategy as never], coreFramework as never);

    expect(capturedPrompt).toContain("scoped_execution_checklists");
    expect(capturedPrompt).toContain("EXCLUSIVELY from the GENUINELY GLOBAL core framework rules");
    expect(capturedPrompt).toContain("Always define risk before entry.");

    // The full coreFramework JSON dump (used by OTHER sections like risk_management) legitimately
    // contains the scoped rule too — so isolate the GENUINELY GLOBAL material block shown
    // specifically as master_trading_checklist's own input and check ONLY that block.
    const globalMaterialStart = capturedPrompt.indexOf("GENUINELY GLOBAL core framework material (only source for master_trading_checklist):");
    const scopedMaterialStart = capturedPrompt.indexOf("SCOPED-OR-UNVERIFIED core framework material");
    expect(globalMaterialStart).toBeGreaterThan(-1);
    expect(scopedMaterialStart).toBeGreaterThan(globalMaterialStart);
    const globalMaterialBlock = capturedPrompt.slice(globalMaterialStart, scopedMaterialStart);

    expect(globalMaterialBlock).toContain("Always define risk before entry.");
    // The 9:30-11 AM/options/mega-cap rule must NOT appear in the block shown as master_trading_checklist's own source material.
    expect(globalMaterialBlock).not.toContain("Trade only 9:30-11:00 AM ET");
    expect(globalMaterialBlock).not.toContain("mega-cap");

    // It must instead be present in the SCOPED material block that follows (source for scoped_execution_checklists).
    const scopedMaterialBlock = capturedPrompt.slice(scopedMaterialStart);
    expect(scopedMaterialBlock).toContain("Trade only 9:30-11:00 AM ET");
  });

  it("findUniversalSectionScopeLeaks flags master_trading_checklist prose that leaks real scoped vocabulary under absolute-claim language (deterministic secondary safety net)", async () => {
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");
    const vocabulary = new Set(["options", "market-open"]);
    const leaks = findUniversalSectionScopeLeaks(
      [{ key: "master_trading_checklist", content: "Across every session, only trade liquid options names during market-open." }],
      vocabulary,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].sectionKey).toBe("master_trading_checklist");
    expect(leaks[0].matchedTerms.sort()).toEqual(["market-open", "options"]);
  });

  it("findUniversalSectionScopeLeaks does NOT flag a section merely discussing scoped content without any absolute-claim language", async () => {
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");
    const vocabulary = new Set(["options", "market-open"]);
    const leaks = findUniversalSectionScopeLeaks(
      [{ key: "risk_management", content: "For options traders during the market-open session, size down as a beginner." }],
      vocabulary,
    );
    expect(leaks).toEqual([]);
  });

  it("findUniversalSectionScopeLeaks flags a NON-checklist section (e.g. risk_management) that paraphrases a known scoped/unverified rule's own substance under absolute-claim language, even with zero literal vocabulary-term overlap — the exact real-audit leak", async () => {
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");
    const nonGlobalRuleDescriptions = ["Structure trades to target a minimum reward-to-risk ratio of at least 2:1."];
    const leaks = findUniversalSectionScopeLeaks(
      [{ key: "risk_management", content: "The system enforces a minimum reward-to-risk ratio of at least 2:1 on every planned execution." }],
      new Set(), // deliberately empty — the leaked prose never repeats a literal scope-array word like "options"/"beginner"
      nonGlobalRuleDescriptions,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].sectionKey).toBe("risk_management");
    expect(leaks[0].matchedTerms).toEqual([]);
    expect(leaks[0].matchedNonGlobalRules).toEqual(nonGlobalRuleDescriptions);
  });

  it("findUniversalSectionScopeLeaks does NOT flag master_trading_checklist when its prose stays genuinely global", async () => {
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");
    const vocabulary = new Set(["options", "market-open"]);
    const leaks = findUniversalSectionScopeLeaks(
      [{ key: "master_trading_checklist", content: "Always define risk before entry and confirm the higher-timeframe context." }],
      vocabulary,
    );
    expect(leaks).toEqual([]);
  });

  it("findUniversalSectionScopeLeaks does NOT flag a non-universal section (e.g. scoped_execution_checklists) for legitimately containing scoped vocabulary", async () => {
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");
    const vocabulary = new Set(["options", "market-open"]);
    const leaks = findUniversalSectionScopeLeaks(
      [{ key: "scoped_execution_checklists", content: "Options traders: only trade during market-open." }],
      vocabulary,
    );
    expect(leaks).toEqual([]);
  });

  it("runSynthesis wires universalSectionScopeLeaks onto the final playbook document from the real course-wide scope vocabulary, catching a leak the prompt restriction alone missed", async () => {
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
                  // RAW core-framework rule shape: cites "k1" (the pooled, already-scoped
                  // KnowledgeItem below) rather than self-reporting `scope` — coreFramework.ts
                  // derives the rule's scope deterministically from that citation.
                  rules: [
                    {
                      description: "Trade only during market-open with options.",
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
        if (prompt.includes("Comprehensive Trading Playbook")) {
          // Simulates Gemini paraphrasing scoped material into master_trading_checklist DESPITE the prompt restriction —
          // exactly the gap the deterministic secondary check exists to catch.
          return {
            text: JSON.stringify({
              title: "Playbook",
              sections: [{ key: "master_trading_checklist", title: "Checklist", content: "Across every session, always trade only during market-open with options." }],
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
          // Genuinely scoped (instrument + session, no strategy) — flows into coreFramework's
          // courseKnowledge pool (knowledgeNormalize.ts's otherScopedItems), never a canonical strategy.
          knowledgeItems: [makeKnowledgeItem({ statement: "Trade only during market-open with options.", scope: emptyScope({ marketsOrInstruments: ["options"], sessions: ["market-open"] }) })],
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

    expect(result.playbook.universalSectionScopeLeaks).toHaveLength(1);
    expect(result.playbook.universalSectionScopeLeaks[0].sectionKey).toBe("master_trading_checklist");
    expect(result.playbook.universalSectionScopeLeaks[0].matchedTerms.sort()).toEqual(["market-open", "options"]);
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

  it("mixing a legacy market_context_rules citation with a genuinely global KnowledgeItem citation on the SAME consolidated rule still yields UNVERIFIED — global evidence never dilutes away the unverifiable part", async () => {
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
          // k1 = the market_context_rules legacy entry (pooled first), k2 = the global KnowledgeItem.
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

    const rule = coreFramework.sections[0].rules[0];
    expect(rule.scope).toBeNull();
    expect(rule.scopeBasis).toBe("UNVERIFIED");
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

describe("Real-audit v4, Proof 3 — universalSectionScopeLeaks stays empty for a correctly constructed playbook despite real scoped/unverified underlying data", () => {
  it("a playbook that precisely qualifies its scoped/unverified material (never absolute language) produces zero leaks", async () => {
    const scopeVocabulary = new Set(["options", "beginner"]);
    const nonGlobalRuleDescriptions = ["Structure trades to target a minimum reward-to-risk ratio of at least 2:1.", "Confirm Intraday Fundamentals and QQQ/SPY relative strength/order flow."];
    const { findUniversalSectionScopeLeaks } = await import("../src/synthesis/universalSectionAudit.js");

    const wellBehavedSections = [
      { key: "risk_management", content: "As a baseline, define your risk before entry. For options traders who are beginners, a minimum 2:1 reward-to-risk ratio is typically enforced." },
      { key: "master_trading_checklist", content: "Always define your risk before entry and confirm the higher-timeframe context — these hold for every strategy in this course." },
      { key: "scoped_execution_checklists", content: "Intraday Equities/Options Checklist: confirm Intraday Fundamentals and QQQ/SPY relative strength before entering a Momentum Stock Breakout trade." },
    ];

    const leaks = findUniversalSectionScopeLeaks(wellBehavedSections, scopeVocabulary, nonGlobalRuleDescriptions);
    expect(leaks).toEqual([]);
  });
});
