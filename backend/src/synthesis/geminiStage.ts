import type { z } from "zod";
import type { GeminiClient, GeminiUsage, GeminiCompletionDiagnostics, GeminiThinkingLevel } from "../gemini/client.js";
import { GeminiIncompleteInteractionError, GeminiAnalysisError } from "../gemini/client.js";
import { SynthesisSchemaValidationError, SynthesisGeminiCallError } from "./errors.js";
import { SYNTHESIS_SCHEMA_VERSION } from "./version.js";
import { SYNTHESIS_MAX_OUTPUT_TOKENS, type SynthesisStageForLimits } from "./limits.js";

export interface SynthesisStageDeps {
  gemini: GeminiClient;
  model: string;
}

export interface StageCallResult<T> {
  data: T;
  usage: GeminiUsage;
}

/** A short, safe (no content) identifier for a stage's response schema — logged/persisted on failure, never the schema body itself. */
function schemaIdFor(stage: string): string {
  return `${stage}_${SYNTHESIS_SCHEMA_VERSION}`;
}

/** The explicit max_output_tokens budget for a stage (see synthesis/limits.ts) — undefined for a stage name this map doesn't recognize, in which case the Interactions API's own server-side default applies, same as before this file existed. */
function maxOutputTokensFor(stage: string): number | undefined {
  return SYNTHESIS_MAX_OUTPUT_TOKENS[stage as SynthesisStageForLimits];
}

/**
 * Calls Gemini for one stage, with diagnostic context attached to any
 * failure. This is the ONLY place in the synthesis pipeline that calls
 * `generateStructured()` — previously a real API failure (e.g. a 400 from
 * an invalid/oversized response_format schema) propagated as a bare
 * GeminiAnalysisError with no indication of which stage was even running,
 * because nothing here caught it before it left this function. See
 * SynthesisGeminiCallError's own doc comment for the exact fields it adds.
 *
 * Also passes each stage's explicit max_output_tokens budget (synthesis/
 * limits.ts) through to generateStructured(), and forwards
 * GeminiIncompleteInteractionError's safe completion diagnostics into the
 * thrown SynthesisGeminiCallError when the underlying failure carried them
 * — never the response text itself.
 *
 * `thinkingLevel` is an optional passthrough (see GeminiThinkingLevel) —
 * every current call site omits it, which preserves the server-side
 * default exactly as before this parameter existed. It exists so
 * canonical_strategy's experimental low-thinking variant (see
 * canonicalStrategy.ts / scripts/canonicalStrategyDiagnostic.ts) can be
 * tested without changing any other stage's behavior.
 */
export async function callGeminiForStage(
  deps: SynthesisStageDeps,
  stage: string,
  prompt: string,
  jsonSchema: object,
  thinkingLevel?: GeminiThinkingLevel,
): Promise<{ rawText: string; usage: GeminiUsage; diagnostics: GeminiCompletionDiagnostics | undefined }> {
  const maxOutputTokens = maxOutputTokensFor(stage);
  try {
    const result = await deps.gemini.generateStructured(prompt, deps.model, jsonSchema, maxOutputTokens, thinkingLevel);
    return { rawText: result.text, usage: result.usage, diagnostics: result.diagnostics };
  } catch (err) {
    const diagnostics =
      err instanceof GeminiIncompleteInteractionError ? err.diagnostics : err instanceof GeminiAnalysisError ? err.diagnostics : undefined;
    throw new SynthesisGeminiCallError(stage, deps.model, schemaIdFor(stage), prompt.length, err, maxOutputTokens, diagnostics);
  }
}

/** JSON.parse with stage-tagged error on failure — never logs the offending text, but does attach safe completion diagnostics (output length, brace-matching, etc.) when the caller has them, so a parse failure can be told apart from truncation. */
export function parseStageJson(stage: string, rawText: string, diagnostics?: GeminiCompletionDiagnostics): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    throw new SynthesisSchemaValidationError(`Gemini did not return valid JSON for stage "${stage}".`, stage, diagnostics);
  }
}

/** Validates already-parsed data against a stage's Zod schema — split out from parseStageJson so a stage can validate a locally-enriched object (see canonicalStrategy.ts) without a pointless stringify/reparse round trip. */
export function validateStageData<Schema extends z.ZodTypeAny>(stage: string, data: unknown, zodSchema: Schema): z.infer<Schema> {
  const validation = zodSchema.safeParse(data);
  if (!validation.success) {
    throw new SynthesisSchemaValidationError(
      `Gemini output for stage "${stage}" failed schema validation: ${validation.error.message}`,
      stage,
    );
  }
  return validation.data;
}

/**
 * Shared plumbing for the (common) case of a stage whose Gemini response is
 * validated directly, with no intermediate enrichment step: send a text
 * prompt constrained by a JSON schema, parse the response, validate it
 * against the stage's Zod schema. Every stage function in this directory is
 * a thin wrapper around this call (or, for canonical_strategy, the
 * lower-level pieces above) plus its own prompt-building logic — the actual
 * Gemini I/O and validation are never duplicated per stage.
 */
export async function callStructuredStage<Schema extends z.ZodTypeAny>(
  deps: SynthesisStageDeps,
  stage: string,
  prompt: string,
  jsonSchema: object,
  zodSchema: Schema,
): Promise<StageCallResult<z.infer<Schema>>> {
  const { rawText, usage, diagnostics } = await callGeminiForStage(deps, stage, prompt, jsonSchema);
  const parsed = parseStageJson(stage, rawText, diagnostics);
  const data = validateStageData(stage, parsed, zodSchema);
  return { data, usage };
}
