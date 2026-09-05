import { describe, it, expect } from "vitest";
import type { Interactions } from "@google/genai";
import { extractOutputText } from "../src/gemini/client.js";

function makeInteraction(overrides: Partial<Interactions.Interaction> = {}): Interactions.Interaction {
  return {
    id: "interaction_abc123",
    status: "completed",
    ...overrides,
  };
}

describe("extractOutputText (Interactions API response shape)", () => {
  it("returns the SDK's output_text convenience field when present", () => {
    const interaction = makeInteraction({ output_text: '{"strategy_found":false,"strategies":[]}' });
    expect(extractOutputText(interaction)).toBe('{"strategy_found":false,"strategies":[]}');
  });

  it("falls back to the last model_output step's text content when output_text is absent", () => {
    const steps: Interactions.Interaction["steps"] = [
      { type: "user_input", content: [{ type: "text", text: "analyze this video" }] },
      { type: "model_output", content: [{ type: "text", text: '{"strategy_found":true,"strategies":[]}' }] },
    ];
    const interaction = makeInteraction({ steps });
    expect(extractOutputText(interaction)).toBe('{"strategy_found":true,"strategies":[]}');
  });

  it("falls back to steps when output_text is an empty string", () => {
    const steps: Interactions.Interaction["steps"] = [
      { type: "model_output", content: [{ type: "text", text: "fallback text" }] },
    ];
    const interaction = makeInteraction({ output_text: "", steps });
    expect(extractOutputText(interaction)).toBe("fallback text");
  });

  it("uses the last model_output step when there are multiple", () => {
    const steps: Interactions.Interaction["steps"] = [
      { type: "model_output", content: [{ type: "text", text: "earlier draft" }] },
      { type: "function_call", id: "call_1", name: "get_weather", arguments: {} },
      { type: "model_output", content: [{ type: "text", text: "final answer" }] },
    ];
    const interaction = makeInteraction({ steps });
    expect(extractOutputText(interaction)).toBe("final answer");
  });

  it("returns undefined when neither output_text nor a usable model_output step is present", () => {
    const steps: Interactions.Interaction["steps"] = [
      { type: "function_call", id: "call_1", name: "get_weather", arguments: {} },
    ];
    const interaction = makeInteraction({ steps });
    expect(extractOutputText(interaction)).toBeUndefined();
  });

  it("returns undefined when a model_output step's content has no text block", () => {
    const steps: Interactions.Interaction["steps"] = [
      { type: "model_output", content: [{ type: "image", data: "base64...", mime_type: "image/png" }] },
    ];
    const interaction = makeInteraction({ steps });
    expect(extractOutputText(interaction)).toBeUndefined();
  });

  it("returns undefined for a completely empty interaction", () => {
    expect(extractOutputText(makeInteraction())).toBeUndefined();
  });
});
