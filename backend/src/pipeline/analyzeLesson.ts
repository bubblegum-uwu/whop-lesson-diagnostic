import { extractLessonId, WhopUrlParseError } from "../lib/whopUrl.js";
import type { FetchWhopLesson } from "../whop/client.js";
import { WhopApiError } from "../whop/client.js";
import { buildSignedMuxHlsUrl, InvalidMuxAssetError } from "../mux/signedUrl.js";
import type { RemuxDeps, RemuxOptions, RemuxProgress } from "../ffmpeg/remux.js";
import { remuxToMp4 } from "../ffmpeg/remux.js";
import { withTempMp4File } from "../tempFiles/tempFile.js";
import type { GeminiClient, GeminiUsage } from "../gemini/client.js";
import {
  LessonStrategyAnalysisSchema,
  StrategyOnlyResultSchema,
  KnowledgeOnlyResultSchema,
  STRATEGY_ONLY_EXTRACTION_PROMPT,
  STRATEGY_ONLY_RESPONSE_JSON_SCHEMA,
  KNOWLEDGE_ONLY_EXTRACTION_PROMPT,
  KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA,
  type LessonStrategyAnalysis,
} from "../gemini/schema.js";
import type { ZodType } from "zod";
import { STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS, KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS } from "./limits.js";
import type { SecretRedactor } from "../lib/redact.js";
import { globalRedactor } from "../lib/redact.js";
import type { SafeLogger } from "../lib/logger.js";
import { logger as defaultLogger } from "../lib/logger.js";

export type PipelineStage =
  | "retrieving_lesson"
  | "resolving_secure_video"
  | "preparing_video"
  | "uploading_to_gemini"
  | "gemini_processing"
  | "analyzing_lesson"
  | "validating_result";

export const STAGE_LABELS: Record<PipelineStage, string> = {
  retrieving_lesson: "Retrieving lesson",
  resolving_secure_video: "Resolving secure video",
  preparing_video: "Preparing video",
  uploading_to_gemini: "Uploading to Gemini",
  gemini_processing: "Processing on Gemini",
  analyzing_lesson: "Analyzing lesson",
  validating_result: "Validating result",
};

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly stage: PipelineStage,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export class SchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export interface AnalyzeLessonDeps {
  fetchWhopLesson: FetchWhopLesson;
  gemini: GeminiClient;
  geminiModel: string;
  geminiProcessingMode: "agentic" | "static";
  remux: (
    signedUrl: string,
    outputPath: string,
    options?: RemuxOptions,
    remuxDeps?: RemuxDeps,
  ) => Promise<void>;
  redactor?: SecretRedactor;
  logger?: SafeLogger;
  ffmpegPath?: string;
  /** Real ffmpeg progress, forwarded from remux() — used by the PR2 worker to persist PREPARING_VIDEO progress. Unused by the single-lesson SSE flow. */
  onProgress?: (progress: RemuxProgress) => void;
  /** Fired as soon as a duration is known (from Whop metadata or ffmpeg/ffprobe) — used to backfill lessons.duration_seconds. */
  onDurationDiscovered?: (seconds: number) => void;
}

export interface AnalyzeLessonResult {
  analysis: LessonStrategyAnalysis;
  /** Combined (summed) across both Gemini passes — the same shape every existing persistence caller (worker/mainLoop.ts) already consumes; no downstream change needed. */
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
  };
  /** Per-pass usage, retained for diagnostics only (e.g. scripts/lessonAnalysisDiagnostic.ts) — never persisted (no DB migration for this), and safe for any caller to ignore. */
  passUsage: {
    strategy: GeminiUsage;
    knowledge: GeminiUsage;
  };
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function sumUsage(a: GeminiUsage, b: GeminiUsage): GeminiUsage {
  return {
    inputTokens: sumNullable(a.inputTokens, b.inputTokens),
    outputTokens: sumNullable(a.outputTokens, b.outputTokens),
    thinkingTokens: sumNullable(a.thinkingTokens, b.thinkingTokens),
  };
}

/** JSON.parse + Zod-validate one pass's raw output, with a pass-specific error message so a failure clearly identifies which of the two independent Gemini calls produced it. */
function parseAndValidatePass<T>(rawText: string, schema: ZodType<T>, passLabel: string): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch {
    throw new SchemaValidationError(`Gemini did not return valid JSON for the ${passLabel}.`);
  }
  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    throw new SchemaValidationError(`Gemini output for the ${passLabel} failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Runs the full pipeline described in the Phase 2 spec, extended by the
 * Phase 3.5 two-pass architecture:
 *   extract lesson id -> Whop GET lesson -> build signed Mux URL ->
 *   ffmpeg remux -> Gemini upload -> wait ACTIVE ->
 *   TWO INDEPENDENT Gemini calls against the SAME uploaded file (a
 *   dedicated strategy-extraction pass and a dedicated rich-knowledge
 *   pass, run concurrently) -> Zod-validate each pass independently ->
 *   combine into the existing final LessonStrategyAnalysis shape ->
 *   Zod-validate the combined object -> cleanup temp file + Gemini file
 *   (always, success or failure).
 *
 * See gemini/schema.ts's two-pass changelog for why: repeated real
 * diagnostic runs against the same lesson showed one shared Gemini call
 * asked to do both exhaustive strategy extraction AND exhaustive
 * knowledge extraction produces stochastically variable results (one run:
 * 2 distinct strategies + 20 knowledge items; another run on the
 * identical lesson: 1 merged strategy + 12 knowledge items) — the two
 * objectives were competing for one generation. Splitting into two
 * independent calls (each with no visibility into the other's output)
 * structurally removes that competition rather than continuing to
 * enlarge one shared prompt.
 *
 * Atomic failure semantics fall out of this naturally: if either pass's
 * Gemini call throws, or either pass's own schema validation fails, or
 * the final combined-object validation fails, this whole function throws
 * and returns nothing — the caller (worker/mainLoop.ts) never begins its
 * persistence transaction, so a partial (strategy-only or knowledge-only)
 * result is never persisted.
 */
export async function analyzeLesson(
  lessonUrl: string,
  whopAccessToken: string,
  deps: AnalyzeLessonDeps,
  onStage?: (stage: PipelineStage) => void,
): Promise<AnalyzeLessonResult> {
  const redactor = deps.redactor ?? globalRedactor;
  const log = deps.logger ?? defaultLogger;
  redactor.register(whopAccessToken);

  const emit = (stage: PipelineStage) => {
    log.info(STAGE_LABELS[stage]);
    onStage?.(stage);
  };

  let lessonId: string;
  try {
    lessonId = extractLessonId(lessonUrl);
  } catch (err) {
    throw new PipelineError(
      err instanceof WhopUrlParseError ? err.message : "Could not parse lesson URL.",
      "retrieving_lesson",
      err,
    );
  }

  emit("retrieving_lesson");
  let lessonTitle: string;
  let durationSeconds: number | null;
  let signedPlaybackId: string | null;
  let signedToken: string | null;
  try {
    const lesson = await deps.fetchWhopLesson(lessonId, whopAccessToken);
    lessonTitle = lesson.title;
    durationSeconds = lesson.video_asset?.duration_seconds ?? null;
    signedPlaybackId = lesson.video_asset?.signed_playback_id ?? null;
    signedToken = lesson.video_asset?.signed_video_playback_token ?? null;
    if (durationSeconds != null) {
      deps.onDurationDiscovered?.(durationSeconds);
    }
  } catch (err) {
    if (err instanceof WhopApiError) {
      throw new PipelineError(`Whop API error (${err.status}): ${err.message}`, "retrieving_lesson", err);
    }
    throw new PipelineError("Failed to retrieve lesson from Whop.", "retrieving_lesson", err);
  }

  emit("resolving_secure_video");
  let signedUrl: string;
  try {
    signedUrl = buildSignedMuxHlsUrl(signedPlaybackId ?? "", signedToken ?? "");
    redactor.register(signedUrl);
    redactor.register(signedToken);
  } catch (err) {
    throw new PipelineError(
      err instanceof InvalidMuxAssetError
        ? err.message
        : "Could not build a secure video URL for this lesson.",
      "resolving_secure_video",
      err,
    );
  }

  let strategyUsage: GeminiUsage = { inputTokens: null, outputTokens: null, thinkingTokens: null };
  let knowledgeUsage: GeminiUsage = { inputTokens: null, outputTokens: null, thinkingTokens: null };

  const rawResultTexts = await withTempMp4File(async (tempFilePath) => {
    emit("preparing_video");
    try {
      await deps.remux(signedUrl, tempFilePath, {
        ffmpegPath: deps.ffmpegPath,
        knownDurationSeconds: durationSeconds,
        onProgress: deps.onProgress
          ? (progress) => {
              deps.onProgress?.(progress);
              if (durationSeconds == null && progress.totalSeconds != null) {
                durationSeconds = progress.totalSeconds;
                deps.onDurationDiscovered?.(progress.totalSeconds);
              }
            }
          : undefined,
      });
    } catch (err) {
      throw new PipelineError(
        `Failed to prepare the video for analysis: ${
          err instanceof Error ? redactor.redact(err.message) : "unknown ffmpeg error"
        }`,
        "preparing_video",
        err,
      );
    }

    emit("uploading_to_gemini");
    let file;
    try {
      file = await deps.gemini.uploadFile(tempFilePath);
      emit("gemini_processing");
      file = await deps.gemini.waitUntilActive(file);
    } catch (err) {
      throw new PipelineError(
        `Gemini upload/processing failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "uploading_to_gemini",
        err,
      );
    }

    emit("analyzing_lesson");
    let strategyText: string;
    let knowledgeText: string;
    try {
      // Two independent Gemini calls against the SAME uploaded file — the
      // Files API reference (file.uri) is a stable, reusable resource, not
      // a one-time token, so both calls can safely run concurrently
      // without a second upload/prepare. Promise.all also gives the
      // atomic failure semantics documented on this function: either call
      // rejecting immediately fails this whole stage.
      const [strategyResult, knowledgeResult] = await Promise.all([
        deps.gemini.analyzeVideo(
          file,
          deps.geminiModel,
          deps.geminiProcessingMode,
          STRATEGY_ONLY_EXTRACTION_PROMPT,
          STRATEGY_ONLY_RESPONSE_JSON_SCHEMA,
          STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS,
        ),
        deps.gemini.analyzeVideo(
          file,
          deps.geminiModel,
          deps.geminiProcessingMode,
          KNOWLEDGE_ONLY_EXTRACTION_PROMPT,
          KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA,
          KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS,
        ),
      ]);
      strategyText = strategyResult.text;
      strategyUsage = strategyResult.usage;
      knowledgeText = knowledgeResult.text;
      knowledgeUsage = knowledgeResult.usage;
    } catch (err) {
      throw new PipelineError(
        `Gemini analysis failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "analyzing_lesson",
        err,
      );
    } finally {
      // Always attempt to delete the uploaded Gemini file, success or failure — once, after BOTH passes have settled.
      await deps.gemini.deleteFile(file).catch(() => undefined);
    }

    return { strategyText, knowledgeText };
  });

  emit("validating_result");
  const strategyOnly = parseAndValidatePass(rawResultTexts.strategyText, StrategyOnlyResultSchema, "strategy pass");
  const knowledgeOnly = parseAndValidatePass(rawResultTexts.knowledgeText, KnowledgeOnlyResultSchema, "knowledge pass");

  // Combine both independently-validated passes with the authoritative
  // Whop lesson metadata (never whatever either pass may have echoed
  // back, if anything) into the SAME final shape as before the two-pass
  // split, then re-validate against the unchanged final schema.
  const combined = {
    lesson: { title: lessonTitle, duration_seconds: durationSeconds },
    strategy_found: strategyOnly.strategy_found,
    strategies: strategyOnly.strategies,
    knowledge: knowledgeOnly.knowledge,
  };

  const validation = LessonStrategyAnalysisSchema.safeParse(combined);
  if (!validation.success) {
    throw new SchemaValidationError(
      `Combined lesson analysis failed schema validation: ${validation.error.message}`,
    );
  }

  return {
    analysis: validation.data,
    usage: sumUsage(strategyUsage, knowledgeUsage),
    passUsage: { strategy: strategyUsage, knowledge: knowledgeUsage },
  };
}

// Re-exported so backend/tests can build a signed-URL–free happy path
// without importing the ffmpeg module directly.
export { remuxToMp4 };
