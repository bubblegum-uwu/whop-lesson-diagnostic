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
});

const noStrategyJson = JSON.stringify({
  lesson: { title: "ignored", duration_seconds: 1 },
  strategy_found: false,
  strategies: [],
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
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, thinkingTokens: 50 });
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
});
