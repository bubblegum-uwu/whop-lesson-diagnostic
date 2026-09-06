import { describe, it, expect } from "vitest";
import { SYNTHESIS_MAX_OUTPUT_TOKENS } from "../src/synthesis/limits.js";

/**
 * Locks in the v3 budget revision — canonical_strategy and playbook raised
 * to gemini-3.8-flash's documented 65536-token output ceiling after a real
 * diagnostic run showed canonical_strategy's v2 budget of 32768 was itself
 * insufficient (output_tokens=31032/32768, interaction_status=incomplete
 * for the real "Break and Retest (B&R) with Key Levels and Order Blocks"
 * cluster — see synthesis/limits.ts's changelog). Guards against silently
 * regressing these back down, and against any stage silently exceeding the
 * model's actual ceiling.
 */
const GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS = 65536;

describe("SYNTHESIS_MAX_OUTPUT_TOKENS", () => {
  it("raises canonical_strategy to the documented gemini-3.8-flash ceiling after v2's 32768 was confirmed insufficient", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy).toBe(GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS);
  });

  it("raises playbook alongside canonical_strategy — same reasoning-heavy, large-output profile", () => {
    expect(SYNTHESIS_MAX_OUTPUT_TOKENS.playbook).toBe(GEMINI_3_8_FLASH_MAX_OUTPUT_TOKENS);
  });

  it("keeps cluster_chunk/cluster_merge at their confirmed-sufficient 32768 — real clustering succeeds there", () => {
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
