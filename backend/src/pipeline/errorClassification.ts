import { WhopApiError } from "../whop/client.js";
import { AuthRequiredError } from "../whop/sessionService.js";
import { FfmpegRemuxError } from "../ffmpeg/remux.js";
import { GeminiUploadError, GeminiProcessingFailedError, GeminiAnalysisError } from "../gemini/client.js";
import { SchemaValidationError, PipelineError } from "./analyzeLesson.js";
import { SynthesisGeminiCallError } from "../synthesis/errors.js";

export type ErrorClassification = "transient" | "permanent" | "auth_required";

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Decides how a failure during a batch analysis job should be handled:
 *   - "transient"     -> back to QUEUED with a bounded-backoff next_retry_at
 *   - "permanent"      -> FAILED, terminal
 *   - "auth_required"  -> AUTH_REQUIRED, parked until the operator reconnects
 *
 * Never guesses: an error shape this function doesn't recognize is treated
 * as permanent rather than silently retried forever.
 */
export function classifyError(err: unknown): ErrorClassification {
  // analyzeLesson() wraps every stage failure in a PipelineError carrying
  // the original error as `cause` — classify the real underlying error, not
  // the wrapper, or every pipeline failure would fall through to "permanent".
  if (err instanceof PipelineError && err.cause !== undefined) {
    return classifyError(err.cause);
  }
  // Same unwrap for course-synthesis (Phase 3.4): SynthesisGeminiCallError
  // wraps every generateStructured() failure with stage/model/schema/
  // prompt-size context for diagnostics, but the underlying cause (e.g. a
  // GeminiAnalysisError) is what actually determines transient vs permanent.
  if (err instanceof SynthesisGeminiCallError) {
    return classifyError(err.cause);
  }
  if (err instanceof AuthRequiredError) {
    return "auth_required";
  }
  if (err instanceof WhopApiError) {
    return TRANSIENT_HTTP_STATUSES.has(err.status) ? "transient" : "permanent";
  }
  if (err instanceof SchemaValidationError) {
    return "permanent";
  }
  if (err instanceof FfmpegRemuxError) {
    // A non-zero ffmpeg exit against a signed URL Mux already accepted is
    // treated as permanent (bad/incompatible source); a timeout is transient
    // (could be a slow/overloaded upstream).
    return err.message.includes("timed out") ? "transient" : "permanent";
  }
  if (err instanceof GeminiUploadError || err instanceof GeminiProcessingFailedError || err instanceof GeminiAnalysisError) {
    const message = err.message.toLowerCase();
    if (/\b(429|500|502|503|504)\b/.test(message) || message.includes("timeout") || message.includes("network")) {
      return "transient";
    }
    return "permanent";
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes("econnreset") || message.includes("etimedout") || message.includes("network") || message.includes("timeout")) {
      return "transient";
    }
  }
  return "permanent";
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;

/** Bounded exponential backoff: 30s, 60s, 120s, 240s, ... capped at 10 minutes. */
export function computeNextRetryAt(attemptCount: number, now: Date = new Date()): Date {
  const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attemptCount - 1), MAX_BACKOFF_MS);
  return new Date(now.getTime() + backoffMs);
}
