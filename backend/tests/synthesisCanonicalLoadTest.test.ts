import { describe, it } from "vitest";
import type { Rule, Strategy } from "../src/gemini/schema.js";
import { createGeminiClient, type GeminiClient } from "../src/gemini/client.js";
import { synthesizeCanonicalStrategy } from "../src/synthesis/canonicalStrategy.js";
import type { StrategyInstanceRecord } from "../src/synthesis/normalize.js";
import type { ClusterProposal } from "../src/synthesis/schema.js";
import { SYNTHESIS_MAX_OUTPUT_TOKENS } from "../src/synthesis/limits.js";

/**
 * OPT-IN ONLY — never runs in normal `npm test`/CI (see the shared gate
 * below, identical to tests/synthesisRealApiSmoke.test.ts). The existing
 * schema smoke test proves Gemini ACCEPTS the canonical_strategy_v3 shape,
 * but with a tiny synthetic prompt — it says nothing about what happens at
 * realistic PRODUCTION scale, which is exactly what the "canonical
 * strategy invalid JSON" production failure needs answered. This file
 * calls the REAL synthesizeCanonicalStrategy() — the exact function
 * production runs — against SMALL/MEDIUM/LARGE synthetic clusters with
 * realistic rules/provenance/timestamps/evidence/conflicts/variants, and
 * reports only safe metrics: prompt chars, input/output/thinking tokens,
 * output chars, interaction status, JSON-parse PASS/FAIL, Zod-validation
 * PASS/FAIL. Never logs prompt content or the raw response.
 *
 * Enable exactly like the schema smoke test:
 *   SYNTHESIS_REAL_API_SMOKE_TEST=1 GEMINI_API_KEY=... npx vitest run tests/synthesisCanonicalLoadTest.test.ts
 */
const REAL_API_ENABLED = process.env.SYNTHESIS_REAL_API_SMOKE_TEST === "1" && !!process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

function makeRule(i: number, category: string): Rule {
  return {
    description: `${category} rule ${i}: price must reclaim the prior session's key level with a full-bodied candle close before the setup is considered valid, confirmed by rising relative volume on the reclaim bar.`,
    classification: i % 3 === 0 ? "inferred" : "explicit",
    confidence: 0.7 + (i % 3) * 0.1,
    start_timestamp: `${i}:${(i * 7) % 60}`,
    end_timestamp: i % 2 === 0 ? `${i}:${(i * 7 + 15) % 60}` : null,
    evidence: `"We want to see the level reclaimed with conviction, not just a wick through it" — described around the ${i} minute mark, illustrated with a live chart example of a break-and-retest sequence on the 5-minute timeframe.`,
  };
}

function makeRules(count: number, category: string): Rule[] {
  return Array.from({ length: count }, (_, i) => makeRule(i + 1, category));
}

/** rulesPerCategory scales the synthetic strategy's realism/size — see SIZE_TIERS below. */
function makeSyntheticStrategy(strategyName: string, rulesPerCategory: number): Strategy {
  return {
    strategy_name: strategyName,
    market_or_instrument: ["ES", "NQ"],
    timeframes: ["5m", "15m", "1H"],
    indicators: ["VWAP", "20 EMA", "Volume Profile"],
    setup_conditions: makeRules(rulesPerCategory, "setup"),
    entry_rules: makeRules(rulesPerCategory, "entry"),
    confirmation_rules: makeRules(rulesPerCategory, "confirmation"),
    stop_loss_rules: makeRules(rulesPerCategory, "stop-loss"),
    profit_target_rules: makeRules(rulesPerCategory, "profit-target"),
    trade_management_rules: makeRules(rulesPerCategory, "trade-management"),
    invalidation_rules: makeRules(rulesPerCategory, "invalidation"),
    no_trade_conditions: makeRules(rulesPerCategory, "no-trade"),
    market_context_rules: makeRules(rulesPerCategory, "market-context"),
    visual_discretionary_rules: makeRules(rulesPerCategory, "visual-discretionary"),
    examples_shown: Array.from({ length: Math.max(1, Math.round(rulesPerCategory / 2)) }, (_, i) => `Example ${i + 1}: a live chart walkthrough of the setup forming and playing out over roughly 45 minutes.`),
    ambiguities: rulesPerCategory > 3 ? ["Unclear whether the reclaim candle must close above or merely wick above the level in fast markets."] : [],
  };
}

function makeSyntheticInstance(strategyInstanceId: number, lessonId: number, strategyName: string, rulesPerCategory: number): StrategyInstanceRecord {
  return {
    strategyInstanceId,
    lessonId,
    lessonTitle: `Key Level and Order Block Break and Retest — Lesson ${lessonId}`,
    analysisId: 1000 + lessonId,
    strategyName,
    normalizedName: strategyName.toLowerCase(),
    strategy: makeSyntheticStrategy(strategyName, rulesPerCategory),
  };
}

interface SizeTier {
  label: string;
  memberCount: number;
  rulesPerCategory: number;
}

const SIZE_TIERS: SizeTier[] = [
  { label: "SMALL", memberCount: 1, rulesPerCategory: 1 },
  { label: "MEDIUM", memberCount: 3, rulesPerCategory: 4 },
  { label: "LARGE", memberCount: 6, rulesPerCategory: 9 },
];

const CLUSTER: ClusterProposal = {
  clusterKey: "key-level-order-block-break-and-retest",
  proposedCanonicalName: "Key Level and Order Block Break and Retest",
  memberInstanceIds: [],
  similarityRationale: "All instances teach reclaiming a prior key level or order block with confirmation before entry, across several lessons with minor variations in confirmation timing and management.",
  differencesNotes: "Some instances wait for a full candle close, others accept a wick reclaim with volume confirmation.",
};

describe.skipIf(!REAL_API_ENABLED)("real Gemini API — canonical_strategy load test at realistic production scale", () => {
  const realGemini = createGeminiClient(process.env.GEMINI_API_KEY ?? "");

  for (const tier of SIZE_TIERS) {
    it(
      `${tier.label}: ${tier.memberCount} member instance(s) x ~${tier.rulesPerCategory} rules/category — reports safe metrics only`,
      async () => {
        const members = Array.from({ length: tier.memberCount }, (_, i) =>
          makeSyntheticInstance(i + 1, 10 + i, CLUSTER.proposedCanonicalName, tier.rulesPerCategory),
        );
        const cluster: ClusterProposal = { ...CLUSTER, memberInstanceIds: members.map((m) => m.strategyInstanceId) };

        let promptChars = 0;
        let capturedOutputChars: number | null = null;
        let capturedStatus = "unknown";
        const instrumented: GeminiClient = {
          ...realGemini,
          generateStructured: async (prompt, model, schema, maxOutputTokens) => {
            promptChars = prompt.length;
            try {
              const result = await realGemini.generateStructured(prompt, model, schema, maxOutputTokens);
              capturedOutputChars = result.diagnostics?.outputChars ?? result.text.length;
              capturedStatus = result.diagnostics?.interactionStatus ?? "unknown";
              return result;
            } catch (err) {
              const diag = (err as { diagnostics?: { outputChars: number; interactionStatus: string } } | undefined)?.diagnostics;
              if (diag) {
                capturedOutputChars = diag.outputChars;
                capturedStatus = diag.interactionStatus;
              }
              throw err;
            }
          },
        };

        let jsonParsePass = false;
        let zodValidationPass = false;
        let usageLine = "input=? output=? thinking=?";
        try {
          const { usage } = await synthesizeCanonicalStrategy({ gemini: instrumented, model: MODEL }, cluster, members);
          jsonParsePass = true; // synthesizeCanonicalStrategy() only returns if both JSON.parse and Zod validation succeeded
          zodValidationPass = true;
          usageLine = `input=${usage.inputTokens} output=${usage.outputTokens} thinking=${usage.thinkingTokens}`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A SynthesisSchemaValidationError message already distinguishes JSON.parse failure from Zod-validation failure by wording — never logs the offending text itself.
          jsonParsePass = !message.includes("did not return valid JSON");
          zodValidationPass = false;
          // eslint-disable-next-line no-console
          console.log(`${tier.label.padEnd(8)}FAIL ${message}`);
          throw err;
        } finally {
          // eslint-disable-next-line no-console
          console.log(
            `${tier.label.padEnd(8)}prompt_chars=${promptChars} configured_max_output_tokens=${SYNTHESIS_MAX_OUTPUT_TOKENS.canonical_strategy} ` +
              `output_chars=${capturedOutputChars ?? "?"} interaction_status=${capturedStatus} json_parse=${jsonParsePass ? "PASS" : "FAIL"} zod_validation=${zodValidationPass ? "PASS" : "FAIL"} ${usageLine}`,
          );
        }
      },
      60_000,
    );
  }
});
