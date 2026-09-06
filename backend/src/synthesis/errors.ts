/** Thrown when Gemini's synthesis output isn't valid JSON or fails its stage's Zod schema. Mirrors pipeline/analyzeLesson.ts's SchemaValidationError. */
export class SynthesisSchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
  ) {
    super(message);
    this.name = "SynthesisSchemaValidationError";
  }
}

/**
 * Wraps any failure from GeminiClient.generateStructured() with the stage
 * context it would otherwise lose entirely — before this existed, a real
 * Gemini API failure (as happened in production: a bare "Gemini
 * structured-generation request failed: 400 Request contains an invalid
 * argument.") propagated with no indication of which of the six synthesis
 * stages was even running, so the production failure's actual cause is
 * still unknown. The message is a
 * flat key=value line (grep-able in logs) carrying only SAFE diagnostic
 * fields — stage, model, a short schema identifier, and prompt length in
 * characters — never prompt content (which can contain course-derived
 * material) and never credentials. `cause` is kept for classifyError() to
 * unwrap (see pipeline/errorClassification.ts), never for logging as-is.
 */
export class SynthesisGeminiCallError extends Error {
  constructor(
    public readonly stage: string,
    public readonly model: string,
    public readonly schemaId: string,
    public readonly promptChars: number,
    public readonly cause: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`stage=${stage} schema=${schemaId} model=${model} prompt_chars=${promptChars} error=${causeMessage}`);
    this.name = "SynthesisGeminiCallError";
  }
}
