import { describe, it, expect, vi } from "vitest";
import type { Strategy } from "../src/gemini/schema.js";
import type { GeminiClient, GeminiUsage } from "../src/gemini/client.js";
import { GeminiAnalysisError } from "../src/gemini/client.js";
import { buildStrategySignature, chunkSignatures, type StrategyInstanceRecord } from "../src/synthesis/normalize.js";
import type { LessonKnowledgeSource } from "../src/synthesis/knowledgeNormalize.js";
import { clusterStrategyInstances } from "../src/synthesis/cluster.js";
import { synthesizeCanonicalStrategy, enrichCanonicalStrategy } from "../src/synthesis/canonicalStrategy.js";
import { extractCoreFramework } from "../src/synthesis/coreFramework.js";
import { synthesizePlaybook } from "../src/synthesis/playbook.js";
import { synthesizeDecisionFramework } from "../src/synthesis/decisionFramework.js";
import { runSynthesis } from "../src/synthesis/runSynthesis.js";
import { computeSourceAnalysisHash } from "../src/synthesis/fingerprint.js";
import { CANONICAL_STRATEGY_THINKING_LEVEL } from "../src/synthesis/limits.js";
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

  it("reports real 'Batch N of M' progress for each map-step chunk, and never for the reduce/merge call", async () => {
    const signatures = Array.from({ length: 3 }, (_, i) => buildStrategySignature(makeInstance({ strategyInstanceId: i + 1 })));
    let call = 0;
    const generateStructured = vi.fn(async () => {
      call++;
      if (call <= 3) return { text: clusterResponse([{ memberInstanceIds: [call] }]), usage };
      return { text: clusterResponse([{ memberInstanceIds: [1, 2, 3] }]), usage };
    });
    const gemini = makeGemini({ generateStructured });
    const batchProgress: { completedBatches: number; totalBatches: number }[] = [];

    await clusterStrategyInstances({ gemini, model: "m" }, signatures, 1, (p) => batchProgress.push(p));

    // One "0 of 3" event up front, then "1 of 3", "2 of 3", "3 of 3" — one
    // per completed map-step chunk. The single reduce/merge call afterward
    // never fires its own batch-progress event (it isn't itself a batch).
    expect(batchProgress).toEqual([
      { completedBatches: 0, totalBatches: 3 },
      { completedBatches: 1, totalBatches: 3 },
      { completedBatches: 2, totalBatches: 3 },
      { completedBatches: 3, totalBatches: 3 },
    ]);
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
            // "s1" is the reference key keySourceData assigns to makeInstance()'s
            // single default entry_rules[0] — see canonicalStrategy.ts's v4
            // sourceKeys wire format (schema.ts's changelog).
            sourceKeys: ["s1"],
            conflictSourceKeys: [],
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

  it("passes options.thinkingLevel through to generateStructured's 5th param, and omits it (server default) when not given", async () => {
    const generateStructured = vi.fn(async () => ({ text: validRawCanonicalStrategyJson(), usage }));
    const gemini = makeGemini({ generateStructured });
    const cluster: ClusterProposal = {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1],
      similarityRationale: "r",
      differencesNotes: "",
    };

    await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, [makeInstance()]);
    expect(generateStructured).toHaveBeenLastCalledWith(expect.any(String), "m", expect.any(Object), expect.any(Number), undefined);

    await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, [makeInstance()], { thinkingLevel: "low" });
    expect(generateStructured).toHaveBeenLastCalledWith(expect.any(String), "m", expect.any(Object), expect.any(Number), "low");
  });

  it("tags every source rule in the prompt with a reference key and instructs Gemini to cite keys, not restate evidence/timestamps", async () => {
    let capturedPrompt = "";
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        return { text: validRawCanonicalStrategyJson(), usage };
      }),
    });
    const cluster: ClusterProposal = {
      clusterKey: "br",
      proposedCanonicalName: "Break & Retest",
      memberInstanceIds: [1],
      similarityRationale: "r",
      differencesNotes: "",
    };

    await synthesizeCanonicalStrategy({ gemini, model: "m" }, cluster, [makeInstance()]);

    // The single default entry rule is tagged with reference key "s1" ...
    expect(capturedPrompt).toContain('"key": "s1"');
    // ... and its own evidence/timestamp still appear as INPUT (Gemini needs
    // to read them to reason), but the instructions steer output toward
    // citing the key instead of restating them.
    expect(capturedPrompt).toContain('"evidence": "e"');
    expect(capturedPrompt).toContain("sourceKeys");
    expect(capturedPrompt).toContain("Do NOT restate lessonId, timestamps, or evidence text yourself");
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

    const progressEvents: { stage: string; completedItems: number | null; totalItems: number | null }[] = [];
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
        knowledgeSources: [],
      },
      (event) => progressEvents.push({ stage: event.stage, completedItems: event.completedItems, totalItems: event.totalItems }),
    );

    expect(calls).toEqual(["cluster", "canonical", "core_framework", "playbook", "decision_framework"]);
    // Every distinct stage fires in order — NORMALIZING and CANONICALIZING
    // also fire intermediate countable-progress events (see the dedicated
    // "reports countable progress" tests below), so this only checks the
    // de-duplicated stage sequence, not every individual event.
    const stagesSeen = [...new Set(progressEvents.map((e) => e.stage))];
    expect(stagesSeen).toEqual(["NORMALIZING", "CLUSTERING", "CANONICALIZING", "CORE_FRAMEWORK", "PLAYBOOK", "DECISION_FRAMEWORK"]);
    // Terminal NORMALIZING/CLUSTERING/CANONICALIZING events report real completed==total counts — never fabricated mid-stage.
    expect(progressEvents.at(-1)).toEqual({ stage: "DECISION_FRAMEWORK", completedItems: null, totalItems: null });
    const finalCanonicalizing = [...progressEvents].reverse().find((e) => e.stage === "CANONICALIZING");
    expect(finalCanonicalizing).toEqual({ stage: "CANONICALIZING", completedItems: 1, totalItems: 1 });
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

  it("never fabricates progress during a single long indeterminate Gemini call (core framework, playbook, decision framework)", async () => {
    const clusterJson = JSON.stringify({
      clusters: [{ clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }],
    });
    const gemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("clustering trading-strategy instances")) return { text: clusterJson, usage };
        if (prompt.includes("synthesizing ONE canonical trading strategy")) return { text: validRawCanonicalStrategyJson(), usage };
        if (prompt.includes("Core Trading Framework")) return { text: validCoreFrameworkJson(), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: validPlaybookJson(), usage };
        return { text: validDecisionFrameworkJson(), usage };
      }),
    });

    const events: { stage: string; completedItems: number | null; totalItems: number | null }[] = [];
    await runSynthesis(
      { gemini, model: "m" },
      { courseTitle: "Trading Accelerator", instances: [makeInstance()], lessons: [{ id: 10, title: "Lesson 10", chapterTitle: null, sourceUrl: "https://x" }], noStandaloneSetupLessonIds: [], knowledgeSources: [] },
      (e) => events.push({ stage: e.stage, completedItems: e.completedItems, totalItems: e.totalItems }),
    );

    for (const stage of ["CORE_FRAMEWORK", "PLAYBOOK", "DECISION_FRAMEWORK"]) {
      const stageEvents = events.filter((e) => e.stage === stage);
      // Exactly one "stage started" event, never a growing count invented while the single Gemini call is in flight.
      expect(stageEvents).toEqual([{ stage, completedItems: null, totalItems: null }]);
    }
  });

  it("passes thinkingLevel=\"low\" ONLY to canonical_strategy's Gemini call — every other stage omits it entirely, preserving the server default", async () => {
    const clusterJson = JSON.stringify({
      clusters: [{ clusterKey: "br", proposedCanonicalName: "Break & Retest", memberInstanceIds: [1], similarityRationale: "r", differencesNotes: "" }],
    });
    const thinkingLevelByStage: Record<string, unknown> = {};
    const generateStructured = vi.fn(async (prompt: string, _model: string, _schema: object, _maxOutputTokens?: number, thinkingLevel?: unknown) => {
      if (prompt.includes("clustering trading-strategy instances")) {
        thinkingLevelByStage.cluster_chunk = thinkingLevel;
        return { text: clusterJson, usage };
      }
      if (prompt.includes("synthesizing ONE canonical trading strategy")) {
        thinkingLevelByStage.canonical_strategy = thinkingLevel;
        return { text: validRawCanonicalStrategyJson(), usage };
      }
      if (prompt.includes("Core Trading Framework")) {
        thinkingLevelByStage.core_framework = thinkingLevel;
        return { text: validCoreFrameworkJson(), usage };
      }
      if (prompt.includes("Comprehensive Trading Playbook")) {
        thinkingLevelByStage.playbook = thinkingLevel;
        return { text: validPlaybookJson(), usage };
      }
      thinkingLevelByStage.decision_framework = thinkingLevel;
      return { text: validDecisionFrameworkJson(), usage };
    });
    const gemini = makeGemini({ generateStructured });

    await runSynthesis(
      { gemini, model: "m" },
      { courseTitle: "Trading Accelerator", instances: [makeInstance()], lessons: [{ id: 10, title: "Lesson 10", chapterTitle: null, sourceUrl: "https://x" }], noStandaloneSetupLessonIds: [], knowledgeSources: [] },
    );

    expect(CANONICAL_STRATEGY_THINKING_LEVEL).toBe("low");
    expect(thinkingLevelByStage.canonical_strategy).toBe(CANONICAL_STRATEGY_THINKING_LEVEL);
    expect(thinkingLevelByStage.cluster_chunk).toBeUndefined();
    expect(thinkingLevelByStage.core_framework).toBeUndefined();
    expect(thinkingLevelByStage.playbook).toBeUndefined();
    expect(thinkingLevelByStage.decision_framework).toBeUndefined();
  });

  it("reports no coverage-notes gap when every lesson taught a standalone setup, and no lesson-level extraction gap when knowledgeSources is empty by construction (nothing to extract from, not a failure to extract)", async () => {
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
        knowledgeSources: [],
      },
    );

    const coverageNotes = result.playbook.sections.find((s) => s.key === "coverage_notes");
    expect(coverageNotes?.content).toContain("no coverage gaps to report");

    // Phase 3.5B: status is no longer driven by strategy_found/lesson counts —
    // with knowledgeSources empty, EVERY tracked dimension genuinely lacks
    // evidence, so status is correctly PARTIAL (see the dedicated
    // frameworkCoverage describe block below for the full COMPLETE case).
    expect(result.playbook.frameworkCoverage.status).toBe("PARTIAL");
    expect(result.playbook.frameworkCoverage.missingFrameworkDimensions.length).toBe(13);
    // No no_strategy lesson exists at all here, so there is nothing to call an extraction gap.
    expect(result.playbook.frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction).toBe(0);
    expect(result.playbook.frameworkCoverage.missingSupportingKnowledgeLessonIds).toEqual([]);
  });
});

describe("synthesis/runSynthesis — Phase 3.5B frameworkCoverage (deterministic, evidence-based)", () => {
  const ALL_DIMENSIONS = [
    "market_context",
    "risk_management",
    "position_sizing",
    "scaling_in",
    "scaling_out",
    "trade_management",
    "execution",
    "higher_timeframe",
    "preparation",
    "psychology",
    "no_trade_conditions",
    "warnings",
    "definitions",
  ] as const;

  function fullCourseKnowledgeSources(): LessonKnowledgeSource[] {
    return [
      {
        analysisId: 1,
        lessonId: 10,
        lessonTitle: "Everything Lesson",
        knowledge: {
          summary: "s",
          knowledgeItems: ALL_DIMENSIONS.map((category) => ({
            category,
            statement: `${category} rule`,
            ruleType: "HARD_RULE" as const,
            classification: "explicit" as const,
            confidence: 0.9,
            conditions: null,
            exceptions: [],
            scope: { strategies: [], marketsOrInstruments: [], timeframes: [], sessions: [], traderProfiles: [] },
            numericalValues: [],
            start_timestamp: "0:00",
            end_timestamp: null,
            evidence: "e",
          })),
          examples: [],
          conflictsAndAmbiguities: [],
        },
      },
    ];
  }

  function gemini() {
    return makeGemini({
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
  }

  it("status is COMPLETE when all 13 tracked dimensions have real evidence, regardless of strategy_found — never a Gemini opinion", async () => {
    const result = await runSynthesis(
      { gemini: gemini(), model: "m" },
      {
        courseTitle: "Trading Accelerator",
        instances: [makeInstance()],
        lessons: [{ id: 10, title: "Everything Lesson", chapterTitle: null, sourceUrl: "https://x" }],
        noStandaloneSetupLessonIds: [],
        knowledgeSources: fullCourseKnowledgeSources(),
      },
    );
    expect(result.playbook.frameworkCoverage.status).toBe("COMPLETE");
    expect(result.playbook.frameworkCoverage.missingFrameworkDimensions).toEqual([]);
  });

  it("does NOT depend on strategy_found/instance/canonical-strategy counts — a no_strategy lesson with full-dimension knowledge yields COMPLETE with zero canonical strategies", async () => {
    const noClusterGemini = makeGemini({
      generateStructured: vi.fn(async (prompt: string) => {
        if (prompt.includes("Core Trading Framework")) return { text: validCoreFrameworkJson(), usage };
        if (prompt.includes("Comprehensive Trading Playbook")) return { text: validPlaybookJson(), usage };
        return { text: validDecisionFrameworkJson(), usage };
      }),
    });
    const result = await runSynthesis(
      { gemini: noClusterGemini, model: "m" },
      {
        courseTitle: "Trading Accelerator",
        instances: [], // no strategy instances at all — every lesson is no_strategy
        lessons: [{ id: 10, title: "Everything Lesson", chapterTitle: null, sourceUrl: "https://x" }],
        noStandaloneSetupLessonIds: [10],
        knowledgeSources: fullCourseKnowledgeSources(),
      },
    );
    expect(result.clusters).toEqual([]);
    expect(result.playbook.frameworkCoverage.status).toBe("COMPLETE");
    expect(result.playbook.frameworkCoverage.standaloneStrategyLessonsAnalyzed).toBe(0);
    expect(result.playbook.frameworkCoverage.lessonsWithoutStandaloneSetup).toBe(1);
    // The lesson DID return real extractable knowledge — this is not an extraction gap.
    expect(result.playbook.frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction).toBe(0);
  });

  it("a no_strategy lesson that ALSO returned zero knowledgeItems is a real extraction gap (distinct from missingFrameworkDimensions)", async () => {
    const result = await runSynthesis(
      { gemini: gemini(), model: "m" },
      {
        courseTitle: "Trading Accelerator",
        instances: [makeInstance()],
        lessons: [
          { id: 10, title: "Lesson 10", chapterTitle: null, sourceUrl: "https://x" },
          { id: 11, title: "Empty Lesson", chapterTitle: null, sourceUrl: "https://y" },
        ],
        noStandaloneSetupLessonIds: [11],
        knowledgeSources: [
          { analysisId: 2, lessonId: 11, lessonTitle: "Empty Lesson", knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] } },
        ],
      },
    );
    expect(result.playbook.frameworkCoverage.lessonsMissingSupportingKnowledgeExtraction).toBe(1);
    expect(result.playbook.frameworkCoverage.missingSupportingKnowledgeLessonIds).toEqual([11]);
    expect(result.playbook.frameworkCoverage.status).toBe("PARTIAL");
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
  // Plain default rule content (makeStrategy()'s single entry_rules[0]) —
  // keySourceData assigns "s1" to member 1's rule and "s2" to member 2's
  // rule (both members' first non-empty category is entry_rules, so
  // counting proceeds member-by-member in that order).
  const members: StrategyInstanceRecord[] = [
    makeInstance({ strategyInstanceId: 1, lessonId: 10, lessonTitle: "Break and Retest Basics" }),
    makeInstance({ strategyInstanceId: 2, lessonId: 20, lessonTitle: "Advanced Retests" }),
  ];

  // Same shape, but with DISTINCT entry-rule evidence/timestamps per member
  // — needed to prove resolveSourceKeys actually threads through the right
  // per-instance data rather than coincidentally returning identical values.
  const distinctMembers: StrategyInstanceRecord[] = [
    makeInstance({
      strategyInstanceId: 1,
      lessonId: 10,
      lessonTitle: "Break and Retest Basics",
      strategy: makeStrategy({
        entry_rules: [{ description: "Enter on retest", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "e1" }],
      }),
    }),
    makeInstance({
      strategyInstanceId: 2,
      lessonId: 20,
      lessonTitle: "Advanced Retests",
      strategy: makeStrategy({
        entry_rules: [{ description: "Enter on retest", classification: "explicit", confidence: 0.9, start_timestamp: "2:00", end_timestamp: null, evidence: "e2" }],
      }),
    }),
  ]; // -> s1: lesson 10/instance 1/"1:00"/"e1", s2: lesson 20/instance 2/"2:00"/"e2"

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
      sourceKeys: [] as string[],
      conflictSourceKeys: [] as string[],
      exceptions: [] as string[],
      numericalValues: [] as RawCanonicalStrategy["sections"][number]["rules"][number]["numericalValues"],
      scope: null as RawCanonicalStrategy["sections"][number]["rules"][number]["scope"],
      ...overrides,
    };
  }

  it("resolves lessonTitle/strategyInstanceId/timestamps/evidence for every cited sourceKey from already-known member data, never fabricated", () => {
    const raw = rawStrategy({ sections: [{ category: "entryRules", rules: [rawRule({ sourceKeys: ["s1", "s2"] })] }] });

    const enriched = enrichCanonicalStrategy(raw, distinctMembers);
    expect(enriched.entryRules[0].sources).toEqual([
      { lessonId: 10, lessonTitle: "Break and Retest Basics", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" },
      { lessonId: 20, lessonTitle: "Advanced Retests", strategyInstanceId: 2, startTimestamp: "2:00", endTimestamp: null, evidence: "e2" },
    ]);
  });

  it("drops a sourceKey Gemini invented (not present in the prompt's own data) rather than fabricating a source for it", () => {
    const raw = rawStrategy({ sections: [{ category: "entryRules", rules: [rawRule({ sourceKeys: ["s1", "s999"] })] }] });
    const enriched = enrichCanonicalStrategy(raw, distinctMembers);
    expect(enriched.entryRules[0].sources).toEqual([
      { lessonId: 10, lessonTitle: "Break and Retest Basics", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" },
    ]);
  });

  it("resolves strategyInstanceId exactly even when a lesson contributed more than one instance to the cluster — a rule-level key has no ambiguity to guess at", () => {
    const ambiguousMembers: StrategyInstanceRecord[] = [
      makeInstance({
        strategyInstanceId: 1,
        lessonId: 10,
        lessonTitle: "Multi-Strategy Lesson",
        strategy: makeStrategy({ entry_rules: [{ description: "Rule A", classification: "explicit", confidence: 0.9, start_timestamp: "1:00", end_timestamp: null, evidence: "eA" }] }),
      }),
      makeInstance({
        strategyInstanceId: 2,
        lessonId: 10,
        lessonTitle: "Multi-Strategy Lesson",
        strategy: makeStrategy({ entry_rules: [{ description: "Rule B", classification: "explicit", confidence: 0.9, start_timestamp: "5:00", end_timestamp: null, evidence: "eB" }] }),
      }),
    ]; // -> s1: instance 1's rule, s2: instance 2's rule (same lessonId=10 for both)
    const raw = rawStrategy({
      sourceLessonIds: [10],
      sections: [{ category: "setup", rules: [rawRule({ description: "Setup rule", supportLevel: "SINGLE_SOURCE", supportCount: 1, sourceKeys: ["s2"] })] }],
    });

    const enriched = enrichCanonicalStrategy(raw, ambiguousMembers);
    expect(enriched.setup[0].sources[0]).toEqual({
      lessonId: 10,
      lessonTitle: "Multi-Strategy Lesson",
      strategyInstanceId: 2,
      startTimestamp: "5:00",
      endTimestamp: null,
      evidence: "eB",
    });
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
      conflicts: [{ description: "One source says enter immediately, another waits for confirmation.", sourceKeys: ["s1", "s2"] }],
    });

    const enriched = enrichCanonicalStrategy(raw, distinctMembers);
    expect(enriched.conflicts).toHaveLength(1);
    expect(enriched.conflicts[0].description).toBe(raw.conflicts[0].description);
    expect(enriched.conflicts[0].sources).toEqual([
      { lessonId: 10, lessonTitle: "Break and Retest Basics", strategyInstanceId: 1, startTimestamp: "1:00", endTimestamp: null, evidence: "e1" },
      { lessonId: 20, lessonTitle: "Advanced Retests", strategyInstanceId: 2, startTimestamp: "2:00", endTimestamp: null, evidence: "e2" },
    ]);
  });

  it("end-to-end: synthesizeCanonicalStrategy enriches Gemini's raw response and still validates against the full, unchanged CanonicalStrategySchema", async () => {
    const rawJson = JSON.stringify(rawStrategy({ sections: [{ category: "entryRules", rules: [rawRule({ sourceKeys: ["s1"] })] }] }));
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
    // strategyInstanceId — even though Gemini itself was never asked to restate them,
    // only to cite the reference key ("s1") of the source rule it drew on.
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
