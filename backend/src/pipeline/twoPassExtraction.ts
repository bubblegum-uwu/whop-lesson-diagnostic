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
import { SchemaValidationError } from "./errors.js";

/**
 * Phase 4H-B — the SAME two-pass strategy+knowledge extraction Whop lessons
 * have always run (see pipeline/analyzeLesson.ts's two-pass architecture
 * doc comment), factored out so a second acquisition path (YouTube, see
 * youtube/acquireYouTubeVideo.ts) can reuse it verbatim instead of
 * duplicating frozen Phase 3.5A logic. Imports
 * STRATEGY_ONLY_EXTRACTION_PROMPT / KNOWLEDGE_ONLY_EXTRACTION_PROMPT / the
 * response JSON schemas / LessonStrategyAnalysisSchema from gemini/schema.ts
 * UNCHANGED — never redefines or edits any of them. Has no opinion about
 * where `video` came from (an uploaded Gemini file for Whop, or a direct
 * YouTube URL) and performs no acquisition, upload, or cleanup of its own —
 * that stays entirely with the caller.
 *
 * Split into two steps (runRawTwoPassCalls / validateAndCombineTwoPassResult)
 * rather than one combined function specifically so pipeline/analyzeLesson.ts
 * can keep emitting its "analyzing_lesson"/"validating_result" pipeline
 * stages at EXACTLY the same points it always has (Whop's Gemini-file
 * cleanup and stage-timing behavior is unchanged by this refactor — see the
 * Phase 4H-B PR description's diff audit). A YouTube caller with no
 * equivalent per-stage tracking can call runTwoPassExtraction, the
 * convenience wrapper that just runs both steps in sequence.
 */

/** Structural subset of gemini/client.ts's GeminiFileRef — a GeminiFileRef already satisfies this. */
export interface VideoInputRef {
  uri: string;
  mimeType?: string;
}

export interface TwoPassExtractionSubject {
  /** Never fabricated: the caller's authoritative title (Whop lesson title, or a project_sources title/fallback label for YouTube) — never anything either Gemini pass might echo back. */
  title: string;
  durationSeconds: number | null;
}

export interface CombinedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}

export interface TwoPassExtractionResult {
  analysis: LessonStrategyAnalysis;
  /** Combined (summed) across both Gemini passes. */
  usage: CombinedUsage;
  /** Per-pass usage, retained for diagnostics only — never persisted directly. */
  passUsage: {
    strategy: GeminiUsage;
    knowledge: GeminiUsage;
  };
}

export interface RawTwoPassResult {
  strategyText: string;
  strategyUsage: GeminiUsage;
  knowledgeText: string;
  knowledgeUsage: GeminiUsage;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function sumUsage(a: GeminiUsage, b: GeminiUsage): CombinedUsage {
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

export interface TwoPassExtractionDeps {
  gemini: GeminiClient;
  geminiModel: string;
  geminiProcessingMode: "agentic" | "static";
}

/**
 * The two independent Gemini calls only — no parsing/validation. Two
 * independent calls against the SAME video reference (the Files API
 * reference, or a direct YouTube URL, is a stable, reusable resource, not a
 * one-time token, so both calls can safely run concurrently) — Promise.all
 * gives the atomic failure semantics documented on runTwoPassExtraction:
 * either call rejecting immediately fails this whole step.
 */
export async function runRawTwoPassCalls(video: VideoInputRef, deps: TwoPassExtractionDeps): Promise<RawTwoPassResult> {
  const [strategyResult, knowledgeResult] = await Promise.all([
    deps.gemini.analyzeVideo(
      video,
      deps.geminiModel,
      deps.geminiProcessingMode,
      STRATEGY_ONLY_EXTRACTION_PROMPT,
      STRATEGY_ONLY_RESPONSE_JSON_SCHEMA,
      STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS,
    ),
    deps.gemini.analyzeVideo(
      video,
      deps.geminiModel,
      deps.geminiProcessingMode,
      KNOWLEDGE_ONLY_EXTRACTION_PROMPT,
      KNOWLEDGE_ONLY_RESPONSE_JSON_SCHEMA,
      KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS,
    ),
  ]);
  return {
    strategyText: strategyResult.text,
    strategyUsage: strategyResult.usage,
    knowledgeText: knowledgeResult.text,
    knowledgeUsage: knowledgeResult.usage,
  };
}

/**
 * Parses/validates both raw pass outputs, combines them with the caller's
 * authoritative subject metadata (never whatever either pass may have
 * echoed back) into the frozen LessonStrategyAnalysis shape, and
 * re-validates the combined object. Throws SchemaValidationError — never
 * wrapped — on any failure, exactly as pipeline/analyzeLesson.ts has always
 * propagated a validation failure.
 */
export function validateAndCombineTwoPassResult(subject: TwoPassExtractionSubject, raw: RawTwoPassResult): TwoPassExtractionResult {
  const strategyOnly = parseAndValidatePass(raw.strategyText, StrategyOnlyResultSchema, "strategy pass");
  const knowledgeOnly = parseAndValidatePass(raw.knowledgeText, KnowledgeOnlyResultSchema, "knowledge pass");

  const combined = {
    lesson: { title: subject.title, duration_seconds: subject.durationSeconds },
    strategy_found: strategyOnly.strategy_found,
    strategies: strategyOnly.strategies,
    knowledge: knowledgeOnly.knowledge,
  };

  const validation = LessonStrategyAnalysisSchema.safeParse(combined);
  if (!validation.success) {
    throw new SchemaValidationError(`Combined lesson analysis failed schema validation: ${validation.error.message}`);
  }

  return {
    analysis: validation.data,
    usage: sumUsage(raw.strategyUsage, raw.knowledgeUsage),
    passUsage: { strategy: raw.strategyUsage, knowledge: raw.knowledgeUsage },
  };
}

/** Convenience wrapper for a caller (YouTube) with no per-stage timing to preserve — runs both steps above in sequence. */
export async function runTwoPassExtraction(
  video: VideoInputRef,
  subject: TwoPassExtractionSubject,
  deps: TwoPassExtractionDeps,
): Promise<TwoPassExtractionResult> {
  const raw = await runRawTwoPassCalls(video, deps);
  return validateAndCombineTwoPassResult(subject, raw);
}
