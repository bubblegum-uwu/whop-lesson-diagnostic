import { GoogleGenAI } from "@google/genai";
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

export interface GeminiClient {
  uploadFile(filePath: string): Promise<GeminiFileRef>;
  waitUntilActive(file: GeminiFileRef, pollIntervalMs?: number): Promise<GeminiFileRef>;
  /** Returns the raw JSON text produced by the model (not yet schema-validated). */
  analyzeVideo(file: GeminiFileRef, model: string, processingMode: "agentic" | "static"): Promise<string>;
  deleteFile(file: GeminiFileRef): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts the model's final text output from an Interactions API response.
 * Newer SDK builds expose a convenience `output_text` string; the
 * currently-typed shape instead nests text inside `outputs[]` (or, for
 * agentic responses, inside the final `model_output` step of `steps[]`).
 * We try all three so this keeps working across SDK point releases.
 */
function extractOutputText(interaction: unknown): string | undefined {
  const asAny = interaction as {
    output_text?: string;
    outputs?: Array<{ type?: string; text?: string }>;
    steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };

  if (typeof asAny.output_text === "string" && asAny.output_text.length > 0) {
    return asAny.output_text;
  }

  const fromOutputs = asAny.outputs?.find((o) => o.type === "text" && typeof o.text === "string")
    ?.text;
  if (fromOutputs) return fromOutputs;

  const modelOutputStep = asAny.steps
    ?.filter((s) => s.type === "model_output")
    .at(-1);
  const fromStep = modelOutputStep?.content?.find(
    (c) => c.type === "text" && typeof c.text === "string",
  )?.text;
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
  ): Promise<string> {
    try {
      // NOTE: as of the installed @google/genai SDK version, the published
      // TypeScript types for `interactions.create` have not yet caught up
      // with the documented `processing` field on video input parts (see
      // https://ai.google.dev/gemini-api/docs/video-understanding —
      // "Agentic video understanding"). The REST API and JS runtime accept
      // it; only the .d.ts is behind. We cast at this one boundary rather
      // than losing type safety everywhere else.
      const input = [
        {
          type: "video",
          uri: file.uri,
          mime_type: file.mimeType,
          processing: processingMode,
        },
        { type: "text", text: STRATEGY_EXTRACTION_PROMPT },
      ] as unknown as Parameters<typeof ai.interactions.create>[0]["input"];

      const interaction = await ai.interactions.create({
        model,
        input,
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
      return text;
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
