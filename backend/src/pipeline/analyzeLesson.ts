import { extractLessonId, WhopUrlParseError } from "../lib/whopUrl.js";
import type { FetchWhopLesson } from "../whop/client.js";
import { WhopApiError } from "../whop/client.js";
import { buildSignedMuxHlsUrl, InvalidMuxAssetError } from "../mux/signedUrl.js";
import type { RemuxDeps, RemuxOptions } from "../ffmpeg/remux.js";
import { remuxToMp4 } from "../ffmpeg/remux.js";
import { withTempMp4File } from "../tempFiles/tempFile.js";
import type { GeminiClient } from "../gemini/client.js";
import { LessonStrategyAnalysisSchema, type LessonStrategyAnalysis } from "../gemini/schema.js";
import type { SecretRedactor } from "../lib/redact.js";
import { globalRedactor } from "../lib/redact.js";
import type { SafeLogger } from "../lib/logger.js";
import { logger as defaultLogger } from "../lib/logger.js";

export type PipelineStage =
  | "retrieving_lesson"
  | "resolving_secure_video"
  | "preparing_video"
  | "uploading_to_gemini"
  | "analyzing_lesson"
  | "validating_result";

export const STAGE_LABELS: Record<PipelineStage, string> = {
  retrieving_lesson: "Retrieving lesson",
  resolving_secure_video: "Resolving secure video",
  preparing_video: "Preparing video",
  uploading_to_gemini: "Uploading to Gemini",
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
}

export interface AnalyzeLessonResult {
  analysis: LessonStrategyAnalysis;
}

/**
 * Runs the full pipeline described in the Phase 2 spec:
 *   extract lesson id -> Whop GET lesson -> build signed Mux URL ->
 *   ffmpeg remux -> Gemini upload -> wait ACTIVE -> analyze -> Zod validate
 *   -> cleanup temp file + Gemini file (always, success or failure).
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

  const rawResultText = await withTempMp4File(async (tempFilePath) => {
    emit("preparing_video");
    try {
      await deps.remux(signedUrl, tempFilePath, { ffmpegPath: deps.ffmpegPath });
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
      file = await deps.gemini.waitUntilActive(file);
    } catch (err) {
      throw new PipelineError(
        `Gemini upload/processing failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "uploading_to_gemini",
        err,
      );
    }

    emit("analyzing_lesson");
    let text: string;
    try {
      text = await deps.gemini.analyzeVideo(file, deps.geminiModel, deps.geminiProcessingMode);
    } catch (err) {
      throw new PipelineError(
        `Gemini analysis failed: ${err instanceof Error ? err.message : "unknown error"}`,
        "analyzing_lesson",
        err,
      );
    } finally {
      // Always attempt to delete the uploaded Gemini file, success or failure.
      await deps.gemini.deleteFile(file).catch(() => undefined);
    }

    return text;
  });

  emit("validating_result");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawResultText);
  } catch {
    throw new SchemaValidationError("Gemini did not return valid JSON.");
  }

  // Ensure lesson metadata reflects the authoritative Whop values, not
  // whatever Gemini may have echoed back.
  const withAuthoritativeLessonMeta =
    typeof parsedJson === "object" && parsedJson !== null
      ? {
          ...(parsedJson as Record<string, unknown>),
          lesson: { title: lessonTitle, duration_seconds: durationSeconds },
        }
      : parsedJson;

  const validation = LessonStrategyAnalysisSchema.safeParse(withAuthoritativeLessonMeta);
  if (!validation.success) {
    throw new SchemaValidationError(
      `Gemini output failed schema validation: ${validation.error.message}`,
    );
  }

  return { analysis: validation.data };
}

// Re-exported so backend/tests can build a signed-URL–free happy path
// without importing the ffmpeg module directly.
export { remuxToMp4 };
