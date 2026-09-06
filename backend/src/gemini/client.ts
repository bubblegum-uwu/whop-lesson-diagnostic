import { GoogleGenAI, type Interactions } from "@google/genai";
import { STRATEGY_EXTRACTION_PROMPT, STRATEGY_RESPONSE_JSON_SCHEMA } from "./schema.js";

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
  constructor(message: string) {
    super(message);
    this.name = "GeminiAnalysisError";
  }
}

export interface GeminiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}

export interface AnalyzeVideoResult {
  /** The raw JSON text produced by the model (not yet schema-validated). */
  text: string;
  usage: GeminiUsage;
}

export interface GeminiClient {
  uploadFile(filePath: string): Promise<GeminiFileRef>;
  waitUntilActive(file: GeminiFileRef, pollIntervalMs?: number): Promise<GeminiFileRef>;
  analyzeVideo(file: GeminiFileRef, model: string, processingMode: "agentic" | "static"): Promise<AnalyzeVideoResult>;
  deleteFile(file: GeminiFileRef): Promise<void>;
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
        text: STRATEGY_EXTRACTION_PROMPT,
      };

      const interaction = await ai.interactions.create({
        model,
        input: [videoContent, textContent],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: STRATEGY_RESPONSE_JSON_SCHEMA,
        },
      });

      const text = extractOutputText(interaction);
      if (!text) {
        throw new GeminiAnalysisError("Gemini returned an empty response.");
      }
      return { text, usage: extractUsage(interaction) };
    } catch (err) {
      if (err instanceof GeminiAnalysisError) throw err;
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

  return { uploadFile, waitUntilActive, analyzeVideo, deleteFile };
}
