import type { GeminiUsage } from "../gemini/client.js";

/** Sums token usage across every Gemini call in the pipeline (Stage 2 may call it several times for map/reduce). Null propagates only if every call reported null for that field. */
export function sumUsages(usages: GeminiUsage[]): GeminiUsage {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let thinkingTokens: number | null = null;

  for (const usage of usages) {
    if (usage.inputTokens != null) inputTokens = (inputTokens ?? 0) + usage.inputTokens;
    if (usage.outputTokens != null) outputTokens = (outputTokens ?? 0) + usage.outputTokens;
    if (usage.thinkingTokens != null) thinkingTokens = (thinkingTokens ?? 0) + usage.thinkingTokens;
  }

  return { inputTokens, outputTokens, thinkingTokens };
}
