import type { GeminiCompletionDiagnostics } from "../gemini/client.js";

/**
 * A flat, grep-able, content-free rendering of completion diagnostics —
 * never the response text itself. Shared by both error types below so a
 * log line/persisted error always reads the same way regardless of which
 * one fired. Includes token usage (input/output/thinking) even for a
 * failed call — Gemini bills thinking tokens as output, sharing the same
 * max_output_tokens budget as the visible response, so seeing a large
 * thinking_tokens count alongside a small output_chars count is the
 * concrete signature of "the budget went mostly to thinking, not to the
 * JSON we actually wanted" (see synthesis/limits.ts's changelog for the
 * real diagnostic run that first showed this).
 */
export function formatCompletionDiagnostics(diagnostics: GeminiCompletionDiagnostics): string {
  return (
    `interaction_status=${diagnostics.interactionStatus} output_chars=${diagnostics.outputChars} ` +
    `is_empty=${diagnostics.isEmpty} starts_with_brace=${diagnostics.startsWithOpenBrace} ` +
    `ends_with_brace=${diagnostics.endsWithCloseBrace} has_markdown_fence=${diagnostics.hasMarkdownFence} ` +
    `input_tokens=${diagnostics.usage.inputTokens} output_tokens=${diagnostics.usage.outputTokens} thinking_tokens=${diagnostics.usage.thinkingTokens}`
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
 * Thrown when a DETERMINISTIC invariant this codebase computes itself is
 * violated — never a Gemini output-validation failure (see
 * SynthesisSchemaValidationError for that). Exists specifically for the
 * "playbook canonical strategy count == canonicalStrategies.length"
 * invariant (see runSynthesis.ts's buildCanonicalStrategyLibrarySection)
 * introduced after a real audit found the playbook silently omitting a
 * canonical strategy from Gemini-authored prose. Should be structurally
 * impossible to trigger given how the library section is built (it's
 * generated directly FROM canonicalStrategies, never asked of Gemini) —
 * this is a defensive guard against a future refactor reintroducing the
 * same class of silent-omission bug, not a condition expected to fire in
 * normal operation.
 */
export class SynthesisInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynthesisInvariantError";
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
