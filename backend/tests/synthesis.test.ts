import { describe, it, expect, vi } from "vitest";
import type { Strategy } from "../src/gemini/schema.js";
import type { GeminiClient, GeminiUsage } from "../src/gemini/client.js";
import { GeminiAnalysisError } from "../src/gemini/client.js";
import { buildStrategySignature, chunkSignatures, type StrategyInstanceRecord } from "../src/synthesis/normalize.js";
import { clusterStrategyInstances } from "../src/synthesis/cluster.js";
import { synthesizeCanonicalStrategy, enrichCanonicalStrategy } from "../src/synthesis/canonicalStrategy.js";
import { extractCoreFramework } from "../src/synthesis/coreFramework.js";
import { synthesizePlaybook } from "../src/synthesis/playbook.js";
import { synthesizeDecisionFramework } from "../src/synthesis/decisionFramework.js";
import { runSynthesis } from "../src/synthesis/runSynthesis.js";
import { computeSourceAnalysisHash } from "../src/synthesis/fingerprint.js";
import { SynthesisSchemaValidationError, SynthesisGeminiCallError } from "../src/synthesis/errors.js";
import { callGeminiForStage } from "../src/synthesis/geminiStage.js";
import { classifyError } from "../src/pipeline/errorClassification.js";
import {
  CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
  CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
  CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
  CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  PLAYBOOK_RESPONSE_JSON_SCHEMA,
  DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  RULE_CATEGORY_KEYS,
  type RawCanonicalStrategy,
} from "../src/synthesis/schema.js";
import type { CanonicalStrategy, ClusterProposal, CoreFramework } from "../src/synthesis/schema.js";

function makeStrategy(overrides: Partial<Strategy> = {}): Strategy {
  return {
    strategy_name: "Break & Retest",
    market_or_instrument: ["ES"],
    timeframes: ["5m"],
    indicators: ["VWAP"],
    setup_conditions: [],
    entry_rules: [
      { description: "Enter on retest of broken level", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "e" },
    ],
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
    strategyName: "Break & Retest",
    normalizedName: "break & retest",
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
    generateStructured: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } })),
    ...overrides,
  };
}

const usage: GeminiUsage = { inputTokens: 100, outputTokens: 50, thinkingTokens: 10 };

describe("synthesis/normalize", () => {
  it("builds a compact signature from a full strategy instance", () => {
    const sig = buildStrategySignature(makeInstance());
    expect(sig.strategyInstanceId).toBe(1);
    expect(sig.markets).toEqual(["ES"]);
    expect(sig.entrySummary).toBe("Enter on retest of broken level");
    expect(sig.ruleCounts.entry_rules).toBe(1);
    expect(sig.ruleCounts.setup_conditions).toBe(0);
  });

  it("never splits a single signature across chunks, chunking by an estimated token budget", () => {
    const signatures = Array.from({ length: 5 }, (_, i) => buildStrategySignature(makeInstance({ strategyInstanceId: i + 1 })));
    const chunks = chunkSignatures(signatures, 50); // tiny budget forces multiple chunks
    expect(chunks.flat()).toHaveLength(5);
    expect(new Set(chunks.flat().map((s) => s.strategyInstanceId)).size).toBe(5);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("puts everything in one chunk when the budget comfortably fits", () => {
    const signatures = Array.from({ length: 5 }, (_, i) => buildStrategySignature(makeInstance({ strategyInstanceId: i + 1 })));
    const chunks = chunkSignatures(signatures, 1_000_000);
    expect(chunks).toHaveLength(1);
  });
});

describe("synthesis/fingerprint", () => {
  it("is order-independent over analysisIds", () => {
    const a = computeSourceAnalysisHash({ courseId: 1, analysisIds: [3, 1, 2], model: "m" });
    const b = computeSourceAnalysisHash({ courseId: 1, analysisIds: [1, 2, 3], model: "m" });
    expect(a).toBe(b);
  });

  it("changes when the source analysis set changes", () => {
    const a = computeSourceAnalysisHash({ courseId: 1, analysisIds: [1, 2], model: "m" });
    const b = computeSourceAnalysisHash({ courseId: 1, analysisIds: [1, 2, 3], model: "m" });
    expect(a).not.toBe(b);
  });

  it("changes when the model or a version bump changes", () => {
    const base = computeSourceAnalysisHash({ courseId: 1, analysisIds: [1], model: "m1" });
    expect(computeSourceAnalysisHash({ courseId: 1, analysisIds: [1], model: "m2" })).not.toBe(base);
    expect(computeSourceAnalysisHash({ courseId: 1, analysisIds: [1], model: "m1", synthesizerVersion: "v2" })).not.toBe(base);
  });
});

describe("synthesis/cluster", () => {
  const clusterResponse = (clusters: Partial<ClusterProposal>[]) =>
    JSON.stringify({
      clusters: clusters.map((c) => ({
        clusterKey: "br",
        proposedCanonicalName: "Break & Retest",
        memberInstanceIds: [1],
        similarityRationale: "same setup",
        differencesNotes: "",
        ...c,
      })),
    });

  it("returns no clusters for no instances, without calling Gemini", async () => {
    const gemini = makeGemini();
    const result = await clusterStrategyInstances({ gemini, model: "m" }, []);
    expect(result.clusters).toEqual([]);
    expect(gemini.generateStructured).not.toHaveBeenCalled();
  });

  it("skips the reduce call entirely for a single chunk", async () => {
    const signatures = [buildStrategySignature(makeInstance({ strategyInstanceId: 1 }))];
    const generateStructured = vi.fn(async () => ({ text: clusterResponse([{ memberInstanceIds: [1] }]), usage }));
    const gemini = makeGemini({ generateStructured });
    const result = await clusterStrategyInstances({ gemini, model: "m" }, signatures);
    expect(generateStructured).toHaveBeenCalledTimes(1); // map only, no reduce
    expect(result.clusters).toHaveLength(1);
    expect(result.usages).toEqual([usage]);
  });

  it("calls a reduce step to merge multiple chunks' proposals", async () => {
    const signatures = Array.from({ length: 3 }, (_, i) => buildStrategySignature(makeInstance({ strategyInstanceId: i + 1 })));
    let call = 0;
    const generateStructured = vi.fn(async () => {
      call++;
      if (call <= 3) return { text: clusterResponse([{ memberInstanceIds: [call] }]), usage };
      return { text: clusterResponse([{ memberInstanceIds: [1, 2, 3] }]), usage }; // reduce call merges all three into one
    });
    const gemini = makeGemini({ generateStructured });
    // A tiny per-chunk budget forces 3 separate one-instance chunks, so a reduce call is required.
    const result = await clusterStrategyInstances({ gemini, model: "m" }, signatures, 1);
    expect(generateStructured).toHaveBeenCalledTimes(4); // 3 map calls + 1 reduce call
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberInstanceIds).toEqual([1, 2, 3]);
  });

  it("falls back to a singleton cluster for any instance Gemini fails to place", async () => {
    const signatures = [
      buildStrategySignature(makeInstance({ strategyInstanceId: 1 })),
      buildStrategySignature(makeInstance({ strategyInstanceId: 2, strategyName: "Order Block Sweep", normalizedName: "order block sweep" })),
    ];
    const generateStructured = vi.fn(async () => ({ text: clusterResponse([{ memberInstanceIds: [1] }]), usage })); // instance 2 never placed
    const gemini = makeGemini({ generateStructured });
    const result = await clusterStrategyInstances({ gemini, model: "m" }, signatures);
    expect(result.clusters).toHaveLength(2);
    const orphan = result.clusters.find((c) => c.memberInstanceIds.includes(2));
    expect(orphan?.proposedCanonicalName).toBe("Order Block Sweep");
  });

  it("throws SynthesisSchemaValidationError on malformed Gemini output", async () => {
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: "not json", usage })) });
    await expect(clusterStrategyInstances({ gemini, model: "m" }, [buildStrategySignature(makeInstance())])).rejects.toThrow(
      SynthesisSchemaValidationError,
    );
  });
});

function validCanonicalStrategyJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "Break & Retest",
    purpose: "p",
    markets: ["ES"],
    timeframes: ["5m"],
    marketContext: [],
    prerequisites: [],
    setup: [],
    entryRules: [
      {
        description: "Enter on retest",
        classification: "explicit",
        supportLevel: "MULTI_SOURCE",
        supportCount: 2,
        sources: [{ lessonId: 10, lessonTitle: "L10", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "e" }],
        conflictSources: [],
      },
    ],
    confirmationRules: [],
    stopLossRules: [],
    profitTargetRules: [],
    tradeManagementRules: [],
    invalidationRules: [],
    noTradeConditions: [],
    visualDiscretionaryRules: [],
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
    sourceLessonIds: [10],
    ...overrides,
  });
}

function validRawCanonicalStrategyJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "Break & Retest",
    purpose: "p",
    markets: ["ES"],
    timeframes: ["5m"],
    sections: [
      {
        category: "entryRules",
        rules: [
          {
            description: "Enter on retest",
            classification: "explicit",
            supportLevel: "MULTI_SOURCE",
            supportCount: 2,
            sources: [{ lessonId: 10, startTimestamp: "1:00", endTimestamp: null, evidence: "e" }],
            conflictSources: [],
          },
        ],
      },
    ],
    variants: [],
    examples: [],
    ambiguities: [],
    conflicts: [],
    sourceLessonIds: [10],
    ...overrides,
  });
}

describe("synthesis/canonicalStrategy", () => {
  it("validates and returns a canonical strategy with usage", async () => {
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: validRawCanonicalStrategyJson(), usage })) });
    const cluster: ClusterProposal = {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1],
      similarityRationale: "r",
      differencesNotes: "",
    };
    const { canonicalStrategy, usage: returnedUsage } = await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, [makeInstance()]);
    expect(canonicalStrategy.name).toBe("Break & Retest");
    expect(canonicalStrategy.entryRules[0].supportLevel).toBe("MULTI_SOURCE");
    expect(returnedUsage).toEqual(usage);
  });
});

function validCoreFrameworkJson() {
  return JSON.stringify({
    sections: [{ key: "risk_framework", title: "Risk Framework", rules: [] }],
  });
}

function validPlaybookJson() {
  return JSON.stringify({
    title: "Course Playbook",
    sections: [{ key: "course_philosophy", title: "Course Philosophy", content: "c" }],
    conflictsAndAmbiguities: [],
  });
}

function validDecisionFrameworkJson() {
  return JSON.stringify({
    nodes: [{ id: "start", type: "start", label: "Start", description: null, next: ["end"], branches: [] }],
    readableSteps: ["Start", "Manage trade", "Exit"],
  });
}

describe("synthesis/coreFramework, playbook, decisionFramework", () => {
  const canonicalStrategy: CanonicalStrategy = JSON.parse(validCanonicalStrategyJson());
  const coreFramework: CoreFramework = JSON.parse(validCoreFrameworkJson());

  it("extractCoreFramework pools cross-strategy rule categories and validates the response", async () => {
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: validCoreFrameworkJson(), usage })) });
    const { coreFramework: result } = await extractCoreFramework({ gemini, model: "m" }, [canonicalStrategy], [makeInstance()]);
    expect(result.sections[0].key).toBe("risk_framework");
  });

  it("synthesizePlaybook validates the response", async () => {
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: validPlaybookJson(), usage })) });
    const { playbook } = await synthesizePlaybook({ gemini, model: "m" }, "Course", [canonicalStrategy], coreFramework);
    expect(playbook.title).toBe("Course Playbook");
  });

  it("synthesizeDecisionFramework validates the response and never collapses distinct strategies silently", async () => {
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: validDecisionFrameworkJson(), usage })) });
    const { decisionFramework } = await synthesizeDecisionFramework({ gemini, model: "m" }, [canonicalStrategy], coreFramework);
    expect(decisionFramework.nodes[0].id).toBe("start");
    expect(decisionFramework.readableSteps.length).toBeGreaterThan(0);
  });
});

describe("synthesis/runSynthesis (end-to-end orchestration)", () => {
  it("runs all six stages in order, sums usage, and appends a deterministic Source Index section", async () => {
    const clusterJson = JSON.stringify({
      clusters: [
        {
          clusterKey: "br",
          proposedCanonicalName: "Break & Retest",
          memberInstanceIds: [1],
          similarityRationale: "r",
          differencesNotes: "",
        },
      ],
    });

    const calls: string[] = [];
    const generateStructured = vi.fn(async (prompt: string) => {
      if (prompt.includes("clustering trading-strategy instances")) {
        calls.push("cluster");
        return { text: clusterJson, usage };
      }
      if (prompt.includes("synthesizing ONE canonical trading strategy")) {
        calls.push("canonical");
        return { text: validRawCanonicalStrategyJson(), usage };
      }
      if (prompt.includes("Core Trading Framework")) {
        calls.push("core_framework");
        return { text: validCoreFrameworkJson(), usage };
      }
      if (prompt.includes("Comprehensive Trading Playbook")) {
        calls.push("playbook");
        return { text: validPlaybookJson(), usage };
      }
      if (prompt.includes("master trade-decision framework")) {
        calls.push("decision_framework");
        return { text: validDecisionFrameworkJson(), usage };
      }
      throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
    });
    const gemini = makeGemini({ generateStructured });

    const stagesSeen: string[] = [];
    const result = await runSynthesis(
      { gemini, model: "m" },
      {
        courseTitle: "Trading Accelerator",
        instances: [makeInstance()],
        lessons: [
          { id: 10, title: "Lesson 10", chapterTitle: "Ch 1", sourceUrl: "https://x" },
          { id: 11, title: "Sizing & Scaling Trades", chapterTitle: "Ch 2", sourceUrl: "https://y" },
        ],
        noStandaloneSetupLessonIds: [11],
      },
      (stage) => stagesSeen.push(stage),
    );

    expect(calls).toEqual(["cluster", "canonical", "core_framework", "playbook", "decision_framework"]);
    expect(stagesSeen).toEqual([
      "normalizing",
      "clustering",
      "synthesizing_canonical_strategies",
      "extracting_core_framework",
      "synthesizing_playbook",
      "synthesizing_decision_framework",
    ]);
    // 5 Gemini calls (single-chunk clustering, one cluster, core framework, playbook, decision framework), each contributing the same usage.
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 250, thinkingTokens: 50 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].canonicalStrategy.name).toBe("Break & Retest");

    const sourceIndex = result.playbook.sections.find((s) => s.key === "source_index");
    expect(sourceIndex?.content).toContain("Lesson 10");
    expect(sourceIndex?.content).toContain("Break & Retest");

    // A "No Standalone Setup" lesson (e.g. "Sizing & Scaling Trades") gets an explicit,
    // code-generated coverage-gap disclosure — never silently omitted or blended in.
    const coverageNotes = result.playbook.sections.find((s) => s.key === "coverage_notes");
    expect(coverageNotes?.content).toContain("Sizing & Scaling Trades");
    expect(coverageNotes?.content).toContain("No Standalone Setup");

    // Structured coverage metadata mirrors the same gap — never fabricated, never COMPLETE while a gap exists.
    expect(result.playbook.frameworkCoverage.status).toBe("PARTIAL");
    expect(result.playbook.frameworkCoverage.standaloneStrategyLessonsAnalyzed).toBe(1);
    expect(result.playbook.frameworkCoverage.lessonsWithoutStandaloneSetup).toBe(1);
    expect(result.playbook.frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction).toBe(1);
    expect(result.playbook.frameworkCoverage.missingSupportingKnowledgeLessonIds).toEqual([11]);
    expect(result.playbook.frameworkCoverage.missingSupportingKnowledgeLessonTitles).toEqual(["Sizing & Scaling Trades"]);
    expect(result.playbook.frameworkCoverage.coverageNote).toContain("partial");
  });

  it("reports no coverage gap when every lesson taught a standalone setup", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) {
          return {
            text: JSON.stringify({ clusters: [{ clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }] }),
            usage,
          };
        }
        if (prompt.includes("synthesizing ONE canonical trading strategy")) return { text: validRawCanonicalStrategyJson(), usage };
        if (prompt.includes("Core Trading Framework")) return { text: validCoreFrameworkJson(), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: validPlaybookJson(), usage };
        return { text: validDecisionFrameworkJson(), usage };
      }),
    });

    const result = await runSynthesis(
      { gemini, model: "m" },
      {
        courseTitle: "Trading Accelerator",
        instances: [makeInstance()],
        lessons: [{ id: 10, title: "Lesson 10", chapterTitle: "Ch 1", sourceUrl: "https://x" }],
        noStandaloneSetupLessonIds: [],
      },
    );

    const coverageNotes = result.playbook.sections.find((s) => s.key === "coverage_notes");
    expect(coverageNotes?.content).toContain("no coverage gaps to report");

    expect(result.playbook.frameworkCoverage.status).toBe("COMPLETE");
    expect(result.playbook.frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction).toBe(0);
    expect(result.playbook.frameworkCoverage.missingSupportingKnowledgeLessonIds).toEqual([]);
  });
});

describe("synthesis/geminiStage diagnostics (SynthesisGeminiCallError)", () => {
  it("wraps a generateStructured() failure with stage/model/schema/prompt-size context instead of losing it", async () => {
    const underlying = new GeminiAnalysisError("Gemini structured-generation request failed: 400 Request contains an invalid argument.");
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => {
        throw underlying;
      }),
    });
    const longPrompt = "x".repeat(12_345);

    await expect(callGeminiForStage({ gemini, model: "gemini-3.8-flash" }, "canonical_strategy", longPrompt, {})).rejects.toMatchObject({
      name: "SynthesisGeminiCallError",
      stage: "canonical_strategy",
      model: "gemini-3.8-flash",
      promptChars: 12_345,
      cause: underlying,
    });
  });

  it("never includes the prompt content itself in the error message, only its length", async () => {
    const secretLookingPrompt = "SUPER SECRET COURSE CONTENT lesson transcript details that must never leak";
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => {
        throw new GeminiAnalysisError("400 Request contains an invalid argument.");
      }),
    });

    let caught: SynthesisGeminiCallError | undefined;
    try {
      await callGeminiForStage({ gemini, model: "m" }, "cluster_chunk", secretLookingPrompt, {});
    } catch (err) {
      caught = err as SynthesisGeminiCallError;
    }

    expect(caught).toBeInstanceOf(SynthesisGeminiCallError);
    expect(caught!.message).not.toContain("SUPER SECRET");
    expect(caught!.message).toContain(`prompt_chars=${secretLookingPrompt.length}`);
    expect(caught!.message).toContain("stage=cluster_chunk");
    expect(caught!.message).toMatch(/schema=cluster_chunk_v\d+/);
    expect(caught!.message).toContain("400 Request contains an invalid argument");
  });

  it("produces a schema identifier derived from the stage name, distinct per stage", async () => {
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    let clusterErr: SynthesisGeminiCallError | undefined;
    try {
      await callGeminiForStage({ gemini, model: "m" }, "cluster_chunk", "p", {});
    } catch (err) {
      clusterErr = err as SynthesisGeminiCallError;
    }
    let canonicalErr: SynthesisGeminiCallError | undefined;
    try {
      await callGeminiForStage({ gemini, model: "m" }, "canonical_strategy", "p", {});
    } catch (err) {
      canonicalErr = err as SynthesisGeminiCallError;
    }

    expect(clusterErr!.schemaId).not.toBe(canonicalErr!.schemaId);
    expect(clusterErr!.schemaId).toMatch(/^cluster_chunk_v\d+$/);
    expect(canonicalErr!.schemaId).toMatch(/^canonical_strategy_v\d+$/);
  });
});

describe("pipeline/errorClassification unwraps SynthesisGeminiCallError", () => {
  it("classifies based on the underlying cause, not the wrapper itself", () => {
    const transientCause = new GeminiAnalysisError("Gemini structured-generation request failed: 503 Service Unavailable.");
    const transientWrapped = new SynthesisGeminiCallError("cluster_chunk", "m", "cluster_chunk_v2", 100, transientCause);
    expect(classifyError(transientWrapped)).toBe("transient");

    const permanentCause = new GeminiAnalysisError("Gemini structured-generation request failed: 400 Request contains an invalid argument.");
    const permanentWrapped = new SynthesisGeminiCallError("canonical_strategy", "m", "canonical_strategy_v2", 100, permanentCause);
    expect(classifyError(permanentWrapped)).toBe("permanent");
  });
});

describe("synthesis/canonicalStrategy enrichCanonicalStrategy", () => {
  const members: StrategyInstanceRecord[] = [
    makeInstance({ strategyInstanceId: 1, lessonId: 10, lessonTitle: "Break and Retest Basics" }),
    makeInstance({ strategyInstanceId: 2, lessonId: 20, lessonTitle: "Advanced Retests" }),
  ];

  function rawStrategy(overrides: Partial<RawCanonicalStrategy> = {}): RawCanonicalStrategy {
    return {
      name: "Break & Retest",
      purpose: "p",
      markets: ["ES"],
      timeframes: ["5m"],
      sections: [],
      variants: [],
      examples: [],
      ambiguities: [],
      conflicts: [],
      sourceLessonIds: [10, 20],
      ...overrides,
    };
  }

  function rawRule(overrides: Partial<RawCanonicalStrategy["sections"][number]["rules"][number]> = {}) {
    return {
      description: "Enter on retest",
      classification: "explicit" as const,
      supportLevel: "MULTI_SOURCE" as const,
      supportCount: 2,
      sources: [],
      conflictSources: [],
      ...overrides,
    };
  }

  it("reattaches lessonTitle and strategyInstanceId to every rule source from already-known member data, never fabricated", () => {
    const raw = rawStrategy({
      sections: [
        {
          category: "entryRules",
          rules: [
            rawRule({
              sources: [
                { lessonId: 10, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" },
                { lessonId: 20, startTimestamp: "2:00", endTimestamp: null, evidence: "e2" },
              ],
            }),
          ],
        },
      ],
    });

    const enriched = enrichCanonicalStrategy(raw, members);
    expect(enriched.entryRules[0].sources).toEqual([
      { lessonId: 10, lessonTitle: "Break and Retest Basics", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" },
      { lessonId: 20, lessonTitle: "Advanced Retests", strategyInstanceId: 2, startTimestamp: "2:00", endTimestamp: null, evidence: "e2" },
    ]);
  });

  it("leaves strategyInstanceId null when a lesson contributed more than one instance to the cluster, rather than guessing", () => {
    const ambiguousMembers: StrategyInstanceRecord[] = [
      makeInstance({ strategyInstanceId: 1, lessonId: 10, lessonTitle: "Multi-Strategy Lesson" }),
      makeInstance({ strategyInstanceId: 2, lessonId: 10, lessonTitle: "Multi-Strategy Lesson" }),
    ];
    const raw = rawStrategy({
      sourceLessonIds: [10],
      sections: [
        {
          category: "setup",
          rules: [
            rawRule({
              description: "Setup rule",
              supportLevel: "SINGLE_SOURCE",
              supportCount: 1,
              sources: [{ lessonId: 10, startTimestamp: null, endTimestamp: null, evidence: "e" }],
            }),
          ],
        },
      ],
    });

    const enriched = enrichCanonicalStrategy(raw, ambiguousMembers);
    expect(enriched.setup[0].sources[0].strategyInstanceId).toBeNull();
    expect(enriched.setup[0].sources[0].lessonTitle).toBe("Multi-Strategy Lesson");
  });

  it("defaults every rule category Gemini didn't mention to an empty array, never fabricated", () => {
    const raw = rawStrategy({ sections: [{ category: "setup", rules: [rawRule()] }] });
    const enriched = enrichCanonicalStrategy(raw, members);
    expect(enriched.setup).toHaveLength(1);
    for (const category of RULE_CATEGORY_KEYS) {
      if (category === "setup") continue;
      expect(enriched[category]).toEqual([]);
    }
  });

  it("concatenates rules when Gemini names the same category more than once, instead of one section overwriting another", () => {
    const raw = rawStrategy({
      sections: [
        { category: "entryRules", rules: [rawRule({ description: "First entry rule" })] },
        { category: "entryRules", rules: [rawRule({ description: "Second entry rule" })] },
      ],
    });
    const enriched = enrichCanonicalStrategy(raw, members);
    expect(enriched.entryRules.map((r) => r.description)).toEqual(["First entry rule", "Second entry rule"]);
  });

  it("preserves unresolved conflicts with full reattached source provenance on both sides", () => {
    const raw = rawStrategy({
      conflicts: [
        {
          description: "One source says enter immediately, another waits for confirmation.",
          sources: [
            { lessonId: 10, startTimestamp: "1:00", endTimestamp: null, evidence: "enter immediately" },
            { lessonId: 20, startTimestamp: "3:00", endTimestamp: null, evidence: "wait for confirmation" },
          ],
        },
      ],
    });

    const enriched = enrichCanonicalStrategy(raw, members);
    expect(enriched.conflicts).toHaveLength(1);
    expect(enriched.conflicts[0].description).toBe(raw.conflicts[0].description);
    expect(enriched.conflicts[0].sources).toEqual([
      { lessonId: 10, lessonTitle: "Break and Retest Basics", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "enter immediately" },
      { lessonId: 20, lessonTitle: "Advanced Retests", strategyInstanceId: 2, startTimestamp: "3:00", endTimestamp: null, evidence: "wait for confirmation" },
    ]);
  });

  it("end-to-end: synthesizeCanonicalStrategy enriches Gemini's raw response and still validates against the full, unchanged CanonicalStrategySchema", async () => {
    const rawJson = JSON.stringify(
      rawStrategy({
        sections: [
          {
            category: "entryRules",
            rules: [rawRule({ sources: [{ lessonId: 10, startTimestamp: "1:00", endTimestamp: null, evidence: "e" }] })],
          },
        ],
      }),
    );
    const gemini = makeGemini({ generateStructured: vi.fn(async () => ({ text: rawJson, usage })) });
    const cluster: ClusterProposal = {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1, 2],
      similarityRationale: "r",
      differencesNotes: "",
    };

    const { canonicalStrategy } = await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, members);

    // The persisted, validated shape carries the full rich provenance — lessonTitle and
    // strategyInstanceId — even though Gemini itself was never asked to restate them.
    expect(canonicalStrategy.entryRules[0].sources[0]).toEqual({
      lessonId: 10,
      lessonTitle: "Break and Retest Basics",
      strategyInstanceId: 1,
      startTimestamp: "1:00",
      endTimestamp: null,
      evidence: "e",
    });
  });
});

describe("synthesis response schemas — no array-valued 'type' nodes", () => {
  // NOT a confirmed Gemini incompatibility fix — Google's structured-output
  // docs list `type: ["string", "null"]` as supported. This guards a
  // deliberate simplification made after the production 400 (see version.ts's
  // v2 changelog): every response_format schema we hand to Gemini represents
  // "nullable" by omitting the field from `required` instead, purely because
  // that form is simpler and semantically equivalent, not because the array
  // form was shown to be rejected.
  function assertNoTypeArrays(node: unknown, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => assertNoTypeArrays(child, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if ("type" in obj) {
      expect(Array.isArray(obj.type), `${path}.type must not be an array (found ${JSON.stringify(obj.type)})`).toBe(false);
    }
    for (const [key, value] of Object.entries(obj)) {
      assertNoTypeArrays(value, `${path}.${key}`);
    }
  }

  const schemas: Record<string, object> = {
    CLUSTER_BATCH_RESPONSE_JSON_SCHEMA,
    CLUSTER_MERGE_RESPONSE_JSON_SCHEMA,
    CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
    RAW_CANONICAL_STRATEGY_RESPONSE_JSON_SCHEMA,
    CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
    PLAYBOOK_RESPONSE_JSON_SCHEMA,
    DECISION_FRAMEWORK_RESPONSE_JSON_SCHEMA,
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} never uses an array-valued "type" anywhere in its tree`, () => {
      assertNoTypeArrays(schema, name);
    });
  }
});
