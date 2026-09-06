import { describe, it, expect, vi } from "vitest";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import {
  analyzeLesson,
  PipelineError,
  SchemaValidationError,
} from "../src/pipeline/analyzeLesson.js";
import { WhopUnauthorizedError, WhopForbiddenError, WhopNotFoundError } from "../src/whop/client.js";
import { FfmpegRemuxError } from "../src/ffmpeg/remux.js";
import {
  GeminiUploadError,
  GeminiProcessingFailedError,
  GeminiAnalysisError,
  type GeminiClient,
  type GeminiFileRef,
} from "../src/gemini/client.js";
import { createSecretRedactor } from "../src/lib/redact.js";
import { STRATEGY_ONLY_EXTRACTION_PROMPT } from "../src/gemini/schema.js";
import type { WhopCourseLessonResponse } from "../src/whop/types.js";
import type { AnalyzeLessonDeps } from "../src/pipeline/analyzeLesson.js";

const LESSON_URL =
  "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/";

const ACCESS_TOKEN = "whop_access_token_for_testing_0001";

function makeLessonResponse(overrides: Partial<WhopCourseLessonResponse> = {}): WhopCourseLessonResponse {
  return {
    id: "lesn_6XyV2SKHYoU4YZdlMF81kl",
    title: "VWAP Reclaim Setup",
    lesson_type: "video",
    visibility: "visible",
    embed_type: null,
    embed_id: null,
    video_asset: {
      id: "mux_abc",
      asset_id: "asset_abc",
      playback_id: null,
      signed_playback_id: "pb_signed_abc",
      status: "ready",
      audio_only: false,
      duration_seconds: 1593,
      signed_video_playback_token: "signed.mux.token.value",
    },
    ...overrides,
  };
}

const emptyKnowledge = { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] };

const validStrategyJson = JSON.stringify({
  lesson: { title: "ignored - overwritten by pipeline", duration_seconds: 1 },
  strategy_found: true,
  strategies: [
    {
      strategy_name: "VWAP Reclaim",
      market_or_instrument: ["SPY"],
      timeframes: ["5m"],
      indicators: ["VWAP"],
      setup_conditions: [],
      entry_rules: [
        {
          description: "Enter on 5m close above VWAP",
          classification: "explicit",
          confidence: 0.85,
          start_timestamp: "03:10",
          end_timestamp: null,
          evidence: "Spoken instruction at 03:10.",
        },
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
    },
  ],
  knowledge: emptyKnowledge,
});

// Phase 3.5: strategy_found=false still carries real, non-empty `knowledge`
// — this is exactly the case the rich-knowledge extractor exists for (a
// lesson with no standalone setup but real risk-management content).
const noStrategyJson = JSON.stringify({
  lesson: { title: "ignored", duration_seconds: 1 },
  strategy_found: false,
  strategies: [],
  knowledge: {
    summary: "Covers position sizing and risk management for scaling into trades.",
    knowledgeItems: [
      {
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
      },
    ],
    examples: [],
    conflictsAndAmbiguities: [],
  },
});

function makeFile(state: GeminiFileRef["state"] = "ACTIVE"): GeminiFileRef {
  return { name: "files/abc123", uri: "https://generativelanguage.googleapis.com/files/abc123", mimeType: "video/mp4", state };
}

function makeDeps(overrides: Partial<AnalyzeLessonDeps> = {}, geminiOverrides: Partial<GeminiClient> = {}): AnalyzeLessonDeps {
  const gemini: GeminiClient = {
    uploadFile: vi.fn(async () => makeFile("ACTIVE")),
    waitUntilActive: vi.fn(async (f: GeminiFileRef) => f),
    analyzeVideo: vi.fn(async () => ({ text: validStrategyJson, usage: { inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 } })),
    deleteFile: vi.fn(async () => undefined),
    generateStructured: vi.fn(async () => ({ text: "{}", usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } })),
    ...geminiOverrides,
  };

  return {
    fetchWhopLesson: vi.fn(async () => makeLessonResponse()),
    gemini,
    geminiModel: "gemini-3.8-flash",
    geminiProcessingMode: "agentic",
    remux: vi.fn(async () => undefined),
    redactor: createSecretRedactor(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("analyzeLesson pipeline", () => {
  it("happy path: returns validated analysis with authoritative lesson title/duration from Whop", async () => {
    const deps = makeDeps();
    const stages: string[] = [];

    const result = await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps, (s) => stages.push(s));

    expect(result.analysis.strategy_found).toBe(true);
    expect(result.analysis.lesson).toEqual({ title: "VWAP Reclaim Setup", duration_seconds: 1593 });
    expect(stages).toEqual([
      "retrieving_lesson",
      "resolving_secure_video",
      "preparing_video",
      "uploading_to_gemini",
      "gemini_processing",
      "analyzing_lesson",
      "validating_result",
    ]);
    // Two independent Gemini calls now happen per analysis (strategy pass +
    // knowledge pass — see pipeline/analyzeLesson.ts's two-pass
    // architecture); the default mock returns the same usage for both
    // calls, so the combined total is double the per-call figure.
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400, thinkingTokens: 100 });
    expect(result.passUsage.strategy).toEqual({ inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 });
    expect(result.passUsage.knowledge).toEqual({ inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 });
  });

  it("registers the Whop access token with the redactor immediately", async () => {
    const redactor = createSecretRedactor();
    const deps = makeDeps({ redactor });
    await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
    expect(redactor.redact(`token was ${ACCESS_TOKEN}`)).not.toContain(ACCESS_TOKEN);
  });

  it("propagates a Whop 401 as a PipelineError at the retrieving_lesson stage", async () => {
    const deps = makeDeps({
      fetchWhopLesson: vi.fn(async () => {
        throw new WhopUnauthorizedError("Invalid or missing token", "unauthorized");
      }),
    });

    let caught: unknown;
    try {
      await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    expect((caught as PipelineError).stage).toBe("retrieving_lesson");
  });

  it("propagates a Whop 403 as a PipelineError", async () => {
    const deps = makeDeps({
      fetchWhopLesson: vi.fn(async () => {
        throw new WhopForbiddenError("Not a member of this course", "forbidden");
      }),
    });
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow(PipelineError);
  });

  it("propagates a Whop 404 as a PipelineError", async () => {
    const deps = makeDeps({
      fetchWhopLesson: vi.fn(async () => {
        throw new WhopNotFoundError("Lesson not found", "not_found");
      }),
    });
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow(PipelineError);
  });

  it("fails at resolving_secure_video when the lesson has no signed playback data", async () => {
    const deps = makeDeps({
      fetchWhopLesson: vi.fn(async () =>
        makeLessonResponse({ video_asset: { ...makeLessonResponse().video_asset!, signed_playback_id: null } }),
      ),
    });

    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({
      stage: "resolving_secure_video",
    });
  });

  it("surfaces an expired/rejected Mux token as a sanitized preparing_video PipelineError", async () => {
    const deps = makeDeps({
      remux: vi.fn(async () => {
        throw new FfmpegRemuxError(
          "ffmpeg exited with code 8. Details: HTTP error 403 Forbidden",
          8,
        );
      }),
    });

    let caught: unknown;
    try {
      await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    expect((caught as PipelineError).stage).toBe("preparing_video");
    expect((caught as PipelineError).message).not.toContain("signed.mux.token.value");
  });

  it("surfaces a generic ffmpeg failure as a preparing_video PipelineError", async () => {
    const deps = makeDeps({
      remux: vi.fn(async () => {
        throw new FfmpegRemuxError("ffmpeg exited with code 1.", 1);
      }),
    });
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({
      stage: "preparing_video",
    });
  });

  it("surfaces a Gemini upload failure as an uploading_to_gemini PipelineError", async () => {
    const deps = makeDeps(
      {},
      { uploadFile: vi.fn(async () => { throw new GeminiUploadError("network error"); }) },
    );
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({
      stage: "uploading_to_gemini",
    });
  });

  it("surfaces a Gemini FAILED processing state as an uploading_to_gemini PipelineError", async () => {
    const deps = makeDeps(
      {},
      {
        waitUntilActive: vi.fn(async () => {
          throw new GeminiProcessingFailedError("state=FAILED");
        }),
      },
    );
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({
      stage: "uploading_to_gemini",
    });
  });

  it("surfaces a Gemini analysis (interactions.create) failure as an analyzing_lesson PipelineError", async () => {
    const deps = makeDeps(
      {},
      { analyzeVideo: vi.fn(async () => { throw new GeminiAnalysisError("model overloaded"); }) },
    );
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({
      stage: "analyzing_lesson",
    });
  });

  it("still deletes the Gemini file when analysis fails after upload succeeded", async () => {
    const deleteFile = vi.fn(async () => undefined);
    const deps = makeDeps(
      {},
      {
        analyzeVideo: vi.fn(async () => { throw new GeminiAnalysisError("boom"); }),
        deleteFile,
      },
    );
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow();
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it("deletes the Gemini file on the happy path too", async () => {
    const deleteFile = vi.fn(async () => undefined);
    const deps = makeDeps({}, { deleteFile });
    await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
    expect(deleteFile).toHaveBeenCalledOnce();
  });

  it("throws SchemaValidationError when Gemini returns invalid JSON", async () => {
    const deps = makeDeps({}, { analyzeVideo: vi.fn(async () => ({ text: "not json at all", usage: { inputTokens: null, outputTokens: null, thinkingTokens: null } })) });
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow(SchemaValidationError);
  });

  it("throws SchemaValidationError when Gemini's JSON doesn't match the required schema", async () => {
    const deps = makeDeps({}, { analyzeVideo: vi.fn(async () => ({ text: JSON.stringify({ strategy_found: true }), usage: { inputTokens: null, outputTokens: null, thinkingTokens: null } })) });
    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow(SchemaValidationError);
  });

  it("returns a successful (non-error) result with strategy_found:false when the lesson teaches no strategy", async () => {
    const deps = makeDeps({}, { analyzeVideo: vi.fn(async () => ({ text: noStrategyJson, usage: { inputTokens: null, outputTokens: null, thinkingTokens: null } })) });
    const result = await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
    expect(result.analysis.strategy_found).toBe(false);
    expect(result.analysis.strategies).toEqual([]);
  });

  it("passes a real, existing temp file path to remux and gemini upload, and cleans it up afterwards", async () => {
    let capturedPath = "";
    const deps = makeDeps({
      remux: vi.fn(async (_url: string, outputPath: string) => {
        capturedPath = outputPath;
        // The temp *directory* must exist during remux (ffmpeg will create
        // the file itself); we don't write the file in this mock.
        await access(dirname(outputPath)).catch(() => {
          throw new Error("expected containing temp directory to exist during remux");
        });
      }),
    });

    await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);

    expect(capturedPath).toMatch(/video\.mp4$/);
    await expect(access(capturedPath)).rejects.toThrow(); // cleaned up afterwards
  });

  it("cleans up the temp file even when the pipeline fails mid-way", async () => {
    let capturedPath = "";
    const deps = makeDeps({
      remux: vi.fn(async (_url: string, outputPath: string) => {
        capturedPath = outputPath;
        throw new FfmpegRemuxError("boom", 1);
      }),
    });

    await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow();
    await expect(access(capturedPath)).rejects.toThrow();
  });

  // Two-pass architecture (test requirements 10/11/14/15): a dedicated
  // strategy-extraction pass and a dedicated knowledge-extraction pass,
  // both against the SAME uploaded video, with atomic failure semantics.
  describe("two-pass architecture", () => {
    it("uploads and prepares the video exactly ONCE per lesson analysis, not once per pass", async () => {
      const uploadFile = vi.fn(async () => makeFile("ACTIVE"));
      const waitUntilActive = vi.fn(async (f: GeminiFileRef) => f);
      const deps = makeDeps({}, { uploadFile, waitUntilActive });

      await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);

      expect(uploadFile).toHaveBeenCalledOnce();
      expect(waitUntilActive).toHaveBeenCalledOnce();
    });

    it("makes exactly two analyzeVideo calls per lesson analysis, both referencing the same uploaded file", async () => {
      const analyzeVideo = vi.fn(async (_file: GeminiFileRef, _model: string, _mode: "agentic" | "static", _prompt: string, _schema: object, _maxTokens?: number) => ({
        text: validStrategyJson,
        usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 },
      }));
      const deps = makeDeps({}, { analyzeVideo });

      await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);

      expect(analyzeVideo).toHaveBeenCalledTimes(2);
      const [firstCallFile] = analyzeVideo.mock.calls[0];
      const [secondCallFile] = analyzeVideo.mock.calls[1];
      expect(secondCallFile).toBe(firstCallFile); // same GeminiFileRef object — no second upload
    });

    it("calls one pass with the strategy-only prompt and the other with a different prompt", async () => {
      const seenPrompts: string[] = [];
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            seenPrompts.push(prompt);
            return { text: validStrategyJson, usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
          }),
        },
      );

      await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);

      expect(seenPrompts).toHaveLength(2);
      expect(seenPrompts).toContain(STRATEGY_ONLY_EXTRACTION_PROMPT);
      expect(new Set(seenPrompts).size).toBe(2); // the two calls use genuinely different prompts
    });

    it("fails the whole analysis when ONLY the strategy pass throws, even though the knowledge pass would have succeeded", async () => {
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) {
              throw new GeminiAnalysisError("strategy pass failed");
            }
            return { text: noStrategyJson, usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
          }),
        },
      );
      await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({ stage: "analyzing_lesson" });
    });

    it("fails the whole analysis when ONLY the knowledge pass throws, even though the strategy pass would have succeeded", async () => {
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) {
              return { text: validStrategyJson, usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
            }
            throw new GeminiAnalysisError("knowledge pass failed");
          }),
        },
      );
      await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toMatchObject({ stage: "analyzing_lesson" });
    });

    it("still deletes the uploaded file exactly once when only one of the two passes fails", async () => {
      const deleteFile = vi.fn(async () => undefined);
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) throw new GeminiAnalysisError("boom");
            return { text: noStrategyJson, usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
          }),
          deleteFile,
        },
      );
      await expect(analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps)).rejects.toThrow();
      expect(deleteFile).toHaveBeenCalledOnce();
    });

    it("fails validation (and the pipeline) when only the strategy pass returns invalid JSON, identifying it as the strategy pass", async () => {
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) {
              return { text: "not json", usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
            }
            return { text: JSON.stringify({ knowledge: emptyKnowledge }), usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
          }),
        },
      );
      let caught: unknown;
      try {
        await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect((caught as SchemaValidationError).message).toContain("strategy pass");
    });

    it("fails validation when only the knowledge pass returns invalid JSON, identifying it as the knowledge pass", async () => {
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) {
              return { text: JSON.stringify({ strategy_found: false, strategies: [] }), usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
            }
            return { text: "not json", usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0 } };
          }),
        },
      );
      let caught: unknown;
      try {
        await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SchemaValidationError);
      expect((caught as SchemaValidationError).message).toContain("knowledge pass");
    });

    it("aggregates usage across both passes into the combined total, while retaining per-pass usage for diagnostics", async () => {
      const deps = makeDeps(
        {},
        {
          analyzeVideo: vi.fn(async (_file, _model, _mode, prompt: string) => {
            if (prompt === STRATEGY_ONLY_EXTRACTION_PROMPT) {
              return { text: validStrategyJson, usage: { inputTokens: 300, outputTokens: 40, thinkingTokens: 5 } };
            }
            return { text: JSON.stringify({ knowledge: emptyKnowledge }), usage: { inputTokens: 700, outputTokens: 60, thinkingTokens: 15 } };
          }),
        },
      );
      const result = await analyzeLesson(LESSON_URL, ACCESS_TOKEN, deps);
      expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 100, thinkingTokens: 20 });
      expect(result.passUsage.strategy).toEqual({ inputTokens: 300, outputTokens: 40, thinkingTokens: 5 });
      expect(result.passUsage.knowledge).toEqual({ inputTokens: 700, outputTokens: 60, thinkingTokens: 15 });
    });
  });
});
