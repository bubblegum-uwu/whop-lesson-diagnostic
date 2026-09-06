import type { z } from "zod";
import type { GeminiClient, GeminiUsage } from "../gemini/client.js";
import { SynthesisSchemaValidationError } from "./errors.js";

export interface SynthesisStageDeps {
  gemini: GeminiClient;
  model: string;
}

export interface StageCallResult<T> {
  data: T;
  usage: GeminiUsage;
}

/**
 * Shared plumbing for every Gemini-calling stage (2-6): send a text prompt
 * constrained by a JSON schema, parse the response, validate it against the
 * stage's Zod schema, and surface a clear error naming the stage on
 * failure. Every stage function in this directory is a thin wrapper around
 * this call plus its own prompt-building logic — the actual Gemini I/O and
 * validation are never duplicated per stage.
 */
export async function callStructuredStage<Schema extends z.ZodTypeAny>(
  deps: SynthesisStageDeps,
  stage: string,
  prompt: string,
  jsonSchema: object,
  zodSchema: Schema,
): Promise<StageCallResult<z.infer<Schema>>> {
  const result = await deps.gemini.generateStructured(prompt, deps.model, jsonSchema);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new SynthesisSchemaValidationError(`Gemini did not return valid JSON for stage "${stage}".`, stage);
  }

  const validation = zodSchema.safeParse(parsed);
  if (!validation.success) {
    throw new SynthesisSchemaValidationError(
      `Gemini output for stage "${stage}" failed schema validation: ${validation.error.message}`,
      stage,
    );
  }

  return { data: validation.data, usage: result.usage };
}
