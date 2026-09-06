import type { z } from "zod";
import type { GeminiClient, GeminiUsage } from "../gemini/client.js";
import { SynthesisSchemaValidationError, SynthesisGeminiCallError } from "./errors.js";
import { SYNTHESIS_SCHEMA_VERSION } from "./version.js";

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

/**
 * Calls Gemini for one stage, with diagnostic context attached to any
 * failure. This is the ONLY place in the synthesis pipeline that calls
 * `generateStructured()` — previously a real API failure (e.g. a 400 from
 * an invalid/oversized response_format schema) propagated as a bare
 * GeminiAnalysisError with no indication of which stage was even running,
 * because nothing here caught it before it left this function. See
 * SynthesisGeminiCallError's own doc comment for the exact fields it adds.
 */
export async function callGeminiForStage(
  deps: SynthesisStageDeps,
  stage: string,
  prompt: string,
  jsonSchema: object,
): Promise<{ rawText: string; usage: GeminiUsage }> {
  try {
    const result = await deps.gemini.generateStructured(prompt, deps.model, jsonSchema);
    return { rawText: result.text, usage: result.usage };
  } catch (err) {
    throw new SynthesisGeminiCallError(stage, deps.model, schemaIdFor(stage), prompt.length, err);
  }
}

/** JSON.parse with stage-tagged error on failure — never logs the offending text. */
export function parseStageJson(stage: string, rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    throw new SynthesisSchemaValidationError(`Gemini did not return valid JSON for stage "${stage}".`, stage);
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
  const { rawText, usage } = await callGeminiForStage(deps, stage, prompt, jsonSchema);
  const parsed = parseStageJson(stage, rawText);
  const data = validateStageData(stage, parsed, zodSchema);
  return { data, usage };
}
