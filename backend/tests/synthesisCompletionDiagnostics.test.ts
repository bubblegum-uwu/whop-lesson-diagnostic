import { describe, it, expect, vi } from "vitest";
import type { GeminiClient, GeminiUsage } from "../src/gemini/client.js";
import { GeminiIncompleteInteractionError, GeminiAnalysisError, computeCompletionDiagnostics } from "../src/gemini/client.js";
import { callGeminiForStage, parseStageJson } from "../src/synthesis/geminiStage.js";
import { SynthesisGeminiCallError, SynthesisSchemaValidationError, formatCompletionDiagnostics } from "../src/synthesis/errors.js";
import { classifyError } from "../src/pipeline/errorClassification.js";
import { SYNTHESIS_MAX_OUTPUT_TOKENS } from "../src/synthesis/limits.js";

/**
 * Covers the "canonical strategy invalid JSON" investigation's core
 * requirement: a Gemini completion that isn't usable (incomplete, budget-
 * exceeded, empty, or genuinely malformed) must produce a SPECIFIC safe
 * error carrying shape diagnostics — never a bare "invalid JSON" with no
 * context, and never the prompt or response text itself.
 */
const zeroUsage: GeminiUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };
/** Represents usage that genuinely couldn't be extracted (e.g. the interaction never reached a state with a usage block) — never fabricated. */
const nullUsage: GeminiUsage = { inputTokens: null, outputTokens: null, thinkingTokens: null };

function makeGemini(overrides: Partial<GeminiClient> = {}): GeminiClient {
  return {
    uploadFile: vi.fn(),
    waitUntilActive: vi.fn(),
    analyzeVideo: vi.fn(),
    deleteFile: vi.fn(),
    generateStructured: vi.fn(async () => ({ text: "{}", usage: zeroUsage, diagnostics: computeCompletionDiagnostics("completed", "{}", zeroUsage) })),
    ...overrides,
  };
}

const usage: GeminiUsage = { inputTokens: 200, outputTokens: 40, thinkingTokens: 5 };

describe("safe completion diagnostics — incomplete/budget_exceeded/failed/cancelled statuses", () => {
  it.each(["incomplete", "budget_exceeded", "failed", "cancelled"] as const)(
    "wraps a %s interaction status as a specific safe error naming the status, never attempting JSON.parse on it",
    async (status) => {
      const diagnostics = computeCompletionDiagnostics(status, '{"partial":', usage);
      const gemini = makeGemini({
        generateStructured: vi.fn(async () => {
          throw new GeminiIncompleteInteractionError(status, diagnostics);
        }),
      });

      let caught: SynthesisGeminiCallError | undefined;
      try {
        await callGeminiForStage({ gemini, model: "gemini-3.8-flash" }, "canonical_strategy", "prompt text", {});
      } catch (err) {
        caught = err as SynthesisGeminiCallError;
      }

      expect(caught).toBeInstanceOf(SynthesisGeminiCallError);
      expect(caught!.message).toContain(`interaction_status=${status}`);
      expect(caught!.message).toContain("stage=canonical_strategy");
      // The configured budget for this stage is visible in the error — see synthesis/limits.ts.
      expect(caught!.message).toContain(`max_output_tokens=${SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy}`);
      // Never the prompt or the (partial) response text itself.
      expect(caught!.message).not.toContain("prompt text");
      expect(caught!.message).not.toContain('"partial"');
    },
  );

  it("classifies an incomplete-interaction failure as permanent (retrying the identical prompt against the identical budget would fail the same way)", () => {
    const diagnostics = computeCompletionDiagnostics("budget_exceeded", "{", nullUsage);
    const err = new GeminiIncompleteInteractionError("budget_exceeded", diagnostics);
    expect(classifyError(err)).toBe("permanent");

    const wrapped = new SynthesisGeminiCallError("canonical_strategy", "m", "canonical_strategy_v3", 100, err, 16384, diagnostics);
    expect(classifyError(wrapped)).toBe("permanent");
  });
});

describe("safe completion diagnostics — empty response", () => {
  it("produces a specific safe error carrying is_empty=true, distinct from a generic parse failure", async () => {
    const diagnostics = computeCompletionDiagnostics("completed", "", zeroUsage);
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => {
        throw new GeminiAnalysisError("Gemini returned an empty response.", diagnostics);
      }),
    });

    let caught: SynthesisGeminiCallError | undefined;
    try {
      await callGeminiForStage({ gemini, model: "m" }, "playbook", "p", {});
    } catch (err) {
      caught = err as SynthesisGeminiCallError;
    }

    expect(caught!.message).toContain("is_empty=true");
    expect(caught!.message).toContain("output_chars=0");
    expect(caught!.message).toContain("Gemini returned an empty response");
  });
});

describe("safe completion diagnostics — malformed JSON despite a completed interaction", () => {
  it("reports safe shape diagnostics (never the offending text) alongside the stage-tagged parse error", () => {
    const diagnostics = computeCompletionDiagnostics("completed", "not json at all", usage);
    let caught: SynthesisSchemaValidationError | undefined;
    try {
      parseStageJson("canonical_strategy", "not json at all", diagnostics);
    } catch (err) {
      caught = err as SynthesisSchemaValidationError;
    }

    expect(caught).toBeInstanceOf(SynthesisSchemaValidationError);
    expect(caught!.message).toContain('Gemini did not return valid JSON for stage "canonical_strategy"');
    expect(caught!.message).toContain("interaction_status=completed");
    expect(caught!.message).toContain("starts_with_brace=false");
    expect(caught!.message).not.toContain("not json at all");
  });

  it("formatCompletionDiagnostics never emits the response text, only shape signals", () => {
    const diagnostics = computeCompletionDiagnostics("completed", "COURSE-DERIVED SECRET TEXT", usage);
    const formatted = formatCompletionDiagnostics(diagnostics);
    expect(formatted).not.toContain("COURSE-DERIVED SECRET TEXT");
    expect(formatted).toContain("interaction_status=completed");
    expect(formatted).toContain("output_chars=");
  });
});

describe("token usage is captured even when the stage ultimately fails", () => {
  it("a SynthesisGeminiCallError carries the configured max_output_tokens even though no usage was ever returned by the failed call itself", async () => {
    // Usage is genuinely unavailable for a call that never got a well-formed
    // response at all — this proves the FAILURE metadata itself (stage,
    // schema, budget, diagnostics) survives even when usage cannot, and
    // that worker/synthesisLoop.ts's cumulativeUsage tracking (see PR
    // "synthesis progress and observability") is exactly what preserves
    // usage from any call that DID complete before this one failed —
    // never lost, never fabricated for the one that didn't.
    const diagnostics = computeCompletionDiagnostics("incomplete", "{", nullUsage);
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => {
        throw new GeminiIncompleteInteractionError("incomplete", diagnostics);
      }),
    });

    let caught: SynthesisGeminiCallError | undefined;
    try {
      await callGeminiForStage({ gemini, model: "m" }, "canonical_strategy", "p", {});
    } catch (err) {
      caught = err as SynthesisGeminiCallError;
    }
    expect(caught!.configuredMaxOutputTokens).toBe(SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy);
    expect(caught!.diagnostics).toEqual(diagnostics);
  });

  it("a successful call still returns real usage alongside diagnostics", async () => {
    const diagnostics = computeCompletionDiagnostics("completed", '{"ok":true}', usage);
    const gemini = makeGemini({
      generateStructured: vi.fn(async () => ({ text: '{"ok":true}', usage, diagnostics })),
    });
    const result = await callGeminiForStage({ gemini, model: "m" }, "core_framework", "p", {});
    expect(result.usage).toEqual(usage);
    expect(result.diagnostics?.interactionStatus).toBe("completed");
  });
});
