/**
 * Versioned, checked-in pricing table. Costs are computed ONLY from token
 * counts Gemini itself already returns (Interaction.total_usage) — never by
 * calling Gemini again to "estimate." `pricing_version` is persisted on every
 * usage_records row so historical costs stay accurate after a future price
 * change here.
 *
 * Prices are per-million-tokens, in USD. Update this table (bumping the
 * version) rather than editing rates in place once real spend has been
 * recorded against an earlier version.
 */
export interface GeminiPricingTable {
  version: string;
  model: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  thinkingPerMillionTokens: number;
}

export const CURRENT_PRICING: GeminiPricingTable = {
  version: "2026-09",
  model: "gemini-3.8-flash",
  inputPerMillionTokens: 0.3,
  outputPerMillionTokens: 2.5,
  thinkingPerMillionTokens: 2.5,
};

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}

/** Returns null (never a guess) when no usage was reported at all. */
export function estimateCost(usage: TokenUsage, pricing: GeminiPricingTable = CURRENT_PRICING): number | null {
  if (usage.inputTokens == null && usage.outputTokens == null && usage.thinkingTokens == null) {
    return null;
  }
  const input = (usage.inputTokens ?? 0) / 1_000_000 * pricing.inputPerMillionTokens;
  const output = (usage.outputTokens ?? 0) / 1_000_000 * pricing.outputPerMillionTokens;
  const thinking = (usage.thinkingTokens ?? 0) / 1_000_000 * pricing.thinkingPerMillionTokens;
  return Math.round((input + output + thinking) * 10_000) / 10_000;
}
