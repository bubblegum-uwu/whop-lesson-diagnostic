import { GoogleGenAI, type Interactions } from "@google/genai";

/**
 * Thin wrapper around the official @google/genai SDK, isolated behind an
 * interface so the pipeline can be tested with a fake implementation
 * without any real network calls, uploads, or API key.
 */

export interface GeminiFileRef {
  name: string;
  uri: string;
  mimeType: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED";
}

export class GeminiUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUploadError";
  }
}

export class GeminiProcessingFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiProcessingFailedError";
  }
}

export class GeminiAnalysisError extends Error {
  constructor(
    message: string,
    /** Set for an empty-response failure from either analyzeVideo or generateStructured — undefined for any other kind of failure (e.g. a raw SDK/network error caught below). */
    public readonly diagnostics?: GeminiCompletionDiagnostics,
  ) {
    super(message);
    this.name = "GeminiAnalysisError";
  }
}

/**
 * The Interactions API's terminal-but-not-successful statuses (see
 * `@google/genai`'s `InteractionStatus`) — a response in one of these
 * states must never be handed to JSON.parse, since its `output_text` can
 * be partial, stale, or entirely absent. Thrown by generateStructured()
 * BEFORE any parsing is attempted, carrying only safe shape diagnostics
 * (never the response text itself) so callers can tell "cut off by an
 * output-token budget" apart from "the model returned something, but it
 * wasn't JSON."
 */
export type GeminiIncompleteStatus = "failed" | "cancelled" | "incomplete" | "budget_exceeded";
const INCOMPLETE_INTERACTION_STATUSES: ReadonlySet<string> = new Set<GeminiIncompleteStatus>([
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}

/**
 * Mirrors `@google/genai`'s `ThinkingLevel` for the Interactions API's
 * `generation_config.thinking_level` — confirmed present on the SDK's own
 * `GenerationConfig` type (genai.d.ts). Optional and unset by default
 * everywhere in this codebase (see synthesis/geminiStage.ts): omitting it
 * preserves whatever the server-side default is (observed as "medium" for
 * gemini-3.8-flash), so adding this plumbing does not by itself change any
 * stage's behavior. Exists so canonical_strategy specifically can be
 * experimentally run at a lower thinking level (see
 * scripts/canonicalStrategyDiagnostic.ts's variant support) without
 * globally lowering thinking for every synthesis stage.
 */
export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

/**
 * Safe, content-free shape signals about a structured-generation response —
 * enough to distinguish truncation/emptiness/non-JSON-content from a
 * genuine parse bug, without ever capturing the response text itself.
 *
 * `usage` is included here — not just on the success path's top-level
 * result — specifically so it survives an INCOMPLETE/budget_exceeded
 * failure too: Gemini's thinking tokens are billed as output and share the
 * same max_output_tokens budget as the visible response (confirmed for
 * this model family; see synthesis/limits.ts's changelog), so a truncated
 * response with a small outputChars count but a large thinkingTokens count
 * is exactly the signature of "the budget went almost entirely to
 * thinking." Without usage on the failure path, that signature would be
 * invisible — which is exactly what happened on the first real diagnostic
 * run this repo saw: output_chars=1990 for a 4096-token budget, with no
 * token counts to explain where the rest of the budget went.
 */
export interface GeminiCompletionDiagnostics {
  /** The Interactions API's `status` field verbatim (e.g. "completed", "incomplete", "budget_exceeded"). */
  interactionStatus: string;
  outputChars: number;
  isEmpty: boolean;
  startsWithOpenBrace: boolean;
  endsWithCloseBrace: boolean;
  hasMarkdownFence: boolean;
  usage: GeminiUsage;
}

export class GeminiIncompleteInteractionError extends Error {
  constructor(
    public readonly interactionStatus: string,
    public readonly diagnostics: GeminiCompletionDiagnostics,
  ) {
    super(`Gemini interaction ended with status "${interactionStatus}" — response was not used.`);
    this.name = "GeminiIncompleteInteractionError";
  }
}

export function computeCompletionDiagnostics(interactionStatus: string, text: string, usage: GeminiUsage): GeminiCompletionDiagnostics {
  const trimmed = text.trim();
  return {
    interactionStatus,
    outputChars: text.length,
    isEmpty: text.length === 0,
    startsWithOpenBrace: trimmed.startsWith("{"),
    endsWithCloseBrace: trimmed.endsWith("}"),
    hasMarkdownFence: trimmed.startsWith("```") || trimmed.includes("\n```"),
    usage,
  };
}

export interface AnalyzeVideoResult {
  /** The raw JSON text produced by the model (not yet schema-validated). */
  text: string;
  usage: GeminiUsage;
  /** Optional only so a test fake GeminiClient can omit it without friction — the real client (createGeminiClient below) always populates it. */
  diagnostics?: GeminiCompletionDiagnostics;
}

export type GenerateStructuredResult = AnalyzeVideoResult;

export interface GeminiClient {
  uploadFile(filePath: string): Promise<GeminiFileRef>;
  waitUntilActive(file: GeminiFileRef, pollIntervalMs?: number): Promise<GeminiFileRef>;
  /**
   * `prompt`/`schema` are explicit parameters (not hardcoded here) so the
   * SAME uploaded video file can be analyzed by multiple independent
   * Gemini calls with different prompts/schemas — see pipeline/
   * analyzeLesson.ts's two-pass architecture (a dedicated strategy-
   * extraction pass and a dedicated rich-knowledge pass against the same
   * uploaded file, combined by application code afterward). Mirrors
   * generateStructured's existing prompt/schema-as-parameters pattern
   * below.
   *
   * `maxOutputTokens`, when provided, is passed through as
   * `generation_config.max_output_tokens` — see pipeline/limits.ts's
   * STRATEGY_ANALYSIS_MAX_OUTPUT_TOKENS/KNOWLEDGE_ANALYSIS_MAX_OUTPUT_TOKENS.
   * Previously always unset (server default); Phase 3.5's richer knowledge
   * schema is enough larger than the old strategy-only schema that an
   * explicit, visible budget (plus the same INCOMPLETE-status safety check
   * generateStructured already has) is warranted the same way it was for
   * synthesis — see GeminiIncompleteInteractionError and
   * computeCompletionDiagnostics.
   */
  analyzeVideo(
    file: GeminiFileRef,
    model: string,
    processingMode: "agentic" | "static",
    prompt: string,
    schema: object,
    maxOutputTokens?: number,
  ): Promise<AnalyzeVideoResult>;
  deleteFile(file: GeminiFileRef): Promise<void>;
  /**
   * Text-only, schema-constrained generation — no file upload/wait/delete
   * involved. Used by course-strategy synthesis (Phase 3.4), which
   * processes already-extracted structured JSON, never raw video, so it
   * deliberately never touches the video-specific methods above.
   *
   * `maxOutputTokens`, when provided, is passed through as the Interactions
   * API's `generation_config.max_output_tokens` — an explicit, visible
   * budget per synthesis stage (see synthesis/limits.ts) rather than
   * leaving it unset and hoping the server default is enough for the
   * richest stages.
   *
   * `thinkingLevel`, when provided, is passed through as
   * `generation_config.thinking_level` — see GeminiThinkingLevel's doc
   * comment. Optional and unused by every stage today; exists for
   * canonical_strategy's experimental low-thinking variant.
   */
  generateStructured(
    prompt: string,
    model: string,
    schema: object,
    maxOutputTokens?: number,
    thinkingLevel?: GeminiThinkingLevel,
  ): Promise<GenerateStructuredResult>;
}

/** Extracts token usage from `Interaction.usage` — never a second Gemini call. */
export function extractUsage(interaction: Interactions.Interaction): GeminiUsage {
  const usage = interaction.usage;
  return {
    inputTokens: usage?.total_input_tokens ?? null,
    outputTokens: usage?.total_output_tokens ?? null,
    thinkingTokens: usage?.total_thought_tokens ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts the model's final text output from an Interactions API response.
 * `output_text` is the SDK's convenience field and covers the normal case;
 * an agentic run that produced its answer inside a `model_output` step
 * without populating `output_text` falls back to that step's text content.
 */
export function extractOutputText(interaction: Interactions.Interaction): string | undefined {
  if (typeof interaction.output_text === "string" && interaction.output_text.length > 0) {
    return interaction.output_text;
  }

  const modelOutputSteps = (interaction.steps ?? []).filter(
    (step): step is Interactions.ModelOutputStep => step.type === "model_output",
  );
  const fromStep = modelOutputSteps
    .at(-1)
    ?.content?.find((c): c is Interactions.TextContent => c.type === "text")?.text;
  if (fromStep) return fromStep;

  return undefined;
}

export function createGeminiClient(apiKey: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });

  async function uploadFile(filePath: string): Promise<GeminiFileRef> {
    try {
      const file = await ai.files.upload({ file: filePath, config: { mimeType: "video/mp4" } });
      return {
        name: file.name ?? "",
        uri: file.uri ?? "",
        mimeType: file.mimeType ?? "video/mp4",
        state: (file.state as GeminiFileRef["state"]) ?? "PROCESSING",
      };
    } catch (err) {
      throw new GeminiUploadError(
        `Gemini file upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function waitUntilActive(
    file: GeminiFileRef,
    pollIntervalMs = 5000,
  ): Promise<GeminiFileRef> {
    let current = file;
    while (current.state === "PROCESSING") {
      await sleep(pollIntervalMs);
      const refreshed = await ai.files.get({ name: current.name });
      current = {
        name: refreshed.name ?? current.name,
        uri: refreshed.uri ?? current.uri,
        mimeType: refreshed.mimeType ?? current.mimeType,
        state: (refreshed.state as GeminiFileRef["state"]) ?? "PROCESSING",
      };
    }
    if (current.state === "FAILED") {
      throw new GeminiProcessingFailedError("Gemini file processing failed (state=FAILED).");
    }
    return current;
  }

  async function analyzeVideo(
    file: GeminiFileRef,
    model: string,
    processingMode: "agentic" | "static",
    prompt: string,
    schema: object,
    maxOutputTokens?: number,
  ): Promise<AnalyzeVideoResult> {
    try {
      const videoContent: Interactions.VideoContent = {
        type: "video",
        uri: file.uri,
        mime_type: file.mimeType,
        processing: processingMode,
      };
      const textContent: Interactions.TextContent = {
        type: "text",
        text: prompt,
      };

      const interaction = await ai.interactions.create({
        model,
        input: [videoContent, textContent],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema,
        },
        ...(maxOutputTokens != null ? { generation_config: { max_output_tokens: maxOutputTokens } } : {}),
      });

      const text = extractOutputText(interaction) ?? "";
      const usage = extractUsage(interaction);
      const diagnostics = computeCompletionDiagnostics(interaction.status, text, usage);

      // Same ordering as generateStructured, and for the same reason: an
      // INCOMPLETE/budget_exceeded interaction's output_text can be
      // partial or stale, so this is checked BEFORE emptiness/JSON.parse —
      // previously analyzeVideo had NO status check at all (only an
      // emptiness check), a gap that mattered little against the old
      // compact strategy-only schema but matters a great deal against the
      // richer Phase 3.5 schema.
      if (INCOMPLETE_INTERACTION_STATUSES.has(interaction.status)) {
        throw new GeminiIncompleteInteractionError(interaction.status, diagnostics);
      }
      if (diagnostics.isEmpty) {
        throw new GeminiAnalysisError("Gemini returned an empty response.", diagnostics);
      }
      return { text, usage, diagnostics };
    } catch (err) {
      if (err instanceof GeminiAnalysisError || err instanceof GeminiIncompleteInteractionError) throw err;
      throw new GeminiAnalysisError(
        `Gemini analysis request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function deleteFile(file: GeminiFileRef): Promise<void> {
    try {
      await ai.files.delete({ name: file.name });
    } catch {
      // Best-effort cleanup; Gemini also auto-expires uploaded files after 48h.
    }
  }

  async function generateStructured(
    prompt: string,
    model: string,
    schema: object,
    maxOutputTokens?: number,
    thinkingLevel?: GeminiThinkingLevel,
  ): Promise<GenerateStructuredResult> {
    try {
      const textContent: Interactions.TextContent = { type: "text", text: prompt };
      const generationConfig =
        maxOutputTokens != null || thinkingLevel != null
          ? {
              generation_config: {
                ...(maxOutputTokens != null ? { max_output_tokens: maxOutputTokens } : {}),
                ...(thinkingLevel != null ? { thinking_level: thinkingLevel } : {}),
              },
            }
          : {};
      const interaction = await ai.interactions.create({
        model,
        input: [textContent],
        response_format: { type: "text", mime_type: "application/json", schema },
        ...generationConfig,
      });

      const text = extractOutputText(interaction) ?? "";
      const usage = extractUsage(interaction);
      const diagnostics = computeCompletionDiagnostics(interaction.status, text, usage);

      // Checked BEFORE emptiness/parsing — an interaction in one of these
      // states can have partial, stale, or missing output_text; feeding it
      // to JSON.parse would misreport a completion-level failure as a
      // generic "invalid JSON" one, losing exactly the signal (status)
      // needed to tell truncation apart from a genuine malformed response.
      // Usage is captured above BEFORE this check specifically so it's
      // still visible even here — Gemini bills thinking tokens as output,
      // sharing the same max_output_tokens budget as the visible response,
      // so a truncated response's thinkingTokens count is often the real
      // explanation for why outputChars looks small relative to the budget.
      if (INCOMPLETE_INTERACTION_STATUSES.has(interaction.status)) {
        throw new GeminiIncompleteInteractionError(interaction.status, diagnostics);
      }
      if (diagnostics.isEmpty) {
        throw new GeminiAnalysisError("Gemini returned an empty response.", diagnostics);
      }
      return { text, usage, diagnostics };
    } catch (err) {
      if (err instanceof GeminiAnalysisError || err instanceof GeminiIncompleteInteractionError) throw err;
      throw new GeminiAnalysisError(
        `Gemini structured-generation request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { uploadFile, waitUntilActive, analyzeVideo, deleteFile, generateStructured };
}
