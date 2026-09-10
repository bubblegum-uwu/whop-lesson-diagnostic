export type PipelineStage =
  | "retrieving_lesson"
  | "resolving_secure_video"
  | "preparing_video"
  | "uploading_to_gemini"
  | "gemini_processing"
  | "analyzing_lesson"
  | "validating_result";

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
