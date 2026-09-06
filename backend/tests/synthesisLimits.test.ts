import { describe, it, expect } from "vitest";
import { SYNTHESIS_MAX_OUTPUT_TOKENS, CANONICAL_STRATEGY_THINKING_LEVEL } from "../src/synthesis/limits.js";

/**
 * Locks in the v5 budget revision — canonical_strategy LOWERED from
 * 65536 back to 32768 after the real fix (the v4 compact `sourceKeys`
 * wire format) confirmed actual output stays in the ~3000-3600 token
 * range on real clusters (see synthesis/limits.ts's changelog). Also
 * locks in CANONICAL_STRATEGY_THINKING_LEVEL="low" — the production
 * thinking-level override confirmed by two real A/B/C diagnostic
 * comparisons (1-member and 2-member clusters) to produce identical
 * correctness at 33-40% lower cost, scoped to canonical_strategy only.
 * Guards against silently regressing these, and against any stage
 * silently exceeding the model's actual output-token ceiling.
 */
const GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS = 65536;

describe("SYNTHESIS_MAX_OUTPUT_TOKENS", () => {
  it("lowers canonical_strategy to 32768 now that the compact sourceKeys wire format keeps real output well under the old 65536 ceiling", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy).toBe(32768);
  });

  it("leaves playbook at the documented gemini-3.8-flash ceiling — no real usage data for this stage yet", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.playbook).toBe(GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS);
  });

  it("keeps cluster_chunk/cluster_merge at their confirmed-sufficient 32768 — real clustering succeeds there, unrelated to canonical_strategy's wire-format fix", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.cluster_chunk).toBe(32768);
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.cluster_merge).toBe(32768);
  });

  it("keeps core_framework/decision_framework unchanged — no evidence yet they're undersized", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.core_framework).toBe(16384);
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.decision_framework).toBe(16384);
  });

  it("never configures any stage above the model's documented output-token ceiling", () => {
    for (const [stage, budget] of Object.entries(SYNTHESIS_MAX_OUTPUT_TOKENS)) {
      expect(budget, `stage=${stage}`).toBeLessThanOrEqual(GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS);
    }
  });
});

describe("CANONICAL_STRATEGY_THINKING_LEVEL", () => {
  it("is 'low' — confirmed by two real diagnostic comparisons (1-member and 2-member clusters) to match server-default correctness at lower cost", () => {
    expect(CANONICAL_STRATEGY_THINKING_LEVEL).toBe("low");
  });
});
