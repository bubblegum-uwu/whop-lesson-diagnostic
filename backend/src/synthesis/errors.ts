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
