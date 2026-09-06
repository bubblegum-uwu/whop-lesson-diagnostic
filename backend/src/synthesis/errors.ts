import type { GeminiCompletionDiagnostics } from "../gemini/client.js";

/** A flat, grep-able, content-free rendering of completion diagnostics — never the response text itself. Shared by both error types below so a log line/persisted error always reads the same way regardless of which one fired. */
export function formatCompletionDiagnostics(diagnostics: GeminiCompletionDiagnostics): string {
  return (
    `interaction_status=${diagnostics.interactionStatus} output_chars=${diagnostics.outputChars} ` +
    `is_empty=${diagnostics.isEmpty} starts_with_brace=${diagnostics.startsWithOpenBrace} ` +
    `ends_with_brace=${diagnostics.endsWithCloseBrace} has_markdown_fence=${diagnostics.hasMarkdownFence}`
  );
}

/**
 * Thrown when Gemini's synthesis output isn't valid JSON or fails its
 * stage's Zod schema. Mirrors pipeline/analyzeLesson.ts's
 * SchemaValidationError. `diagnostics`, when available (JSON.parse
 * failures always have it; a Zod validation failure on already-parsed
 * data does not need it), carries safe completion-shape signals — output
 * length, brace-matching, markdown-fence detection, the Interactions API's
 * own status — so a future "Gemini did not return valid JSON" can be told
 * apart from truncation, an empty response, or genuinely malformed content
 * without ever persisting the response text itself.
 */
export class SynthesisSchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly diagnostics?: GeminiCompletionDiagnostics,
  ) {
    super(diagnostics ? `${message} ${formatCompletionDiagnostics(diagnostics)}` : message);
    this.name = "SynthesisSchemaValidationError";
  }
}

/**
 * Wraps any failure from GeminiClient.generateStructured() with the stage
 * context it would otherwise lose entirely — before this existed, a real
 * Gemini API failure (as happened in production: a bare "Gemini
 * structured-generation request failed: 400 Request contains an invalid
 * argument.") propagated with no indication of which of the six synthesis
 * stages was even running. The message is a flat key=value line (grep-able
 * in logs) carrying only SAFE diagnostic fields — stage, model, a short
 * schema identifier, prompt length in characters, the configured
 * max_output_tokens budget (see synthesis/limits.ts), and, when the
 * underlying failure carried them (a GeminiIncompleteInteractionError —
 * see gemini/client.ts), the same safe completion-shape diagnostics
 * SynthesisSchemaValidationError can carry — never prompt content (which
 * can contain course-derived material) and never credentials. `cause` is
 * kept for classifyError() to unwrap (see pipeline/errorClassification.ts),
 * never for logging as-is.
 */
export class SynthesisGeminiCallError extends Error {
  constructor(
    public readonly stage: string,
    public readonly model: string,
    public readonly schemaId: string,
    public readonly promptChars: number,
    public readonly cause: unknown,
    public readonly configuredMaxOutputTokens?: number,
    public readonly diagnostics?: GeminiCompletionDiagnostics,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    const diagnosticsSuffix = diagnostics ? ` ${formatCompletionDiagnostics(diagnostics)}` : "";
    const budgetSuffix = configuredMaxOutputTokens != null ? ` max_output_tokens=${configuredMaxOutputTokens}` : "";
    super(`stage=${stage} schema=${schemaId} model=${model} prompt_chars=${promptChars}${budgetSuffix} error=${causeMessage}${diagnosticsSuffix}`);
    this.name = "SynthesisGeminiCallError";
  }
}
