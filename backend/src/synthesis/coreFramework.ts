import type { GeminiUsage } from "../gemini/client.js";
import type { Rule } from "../gemini/schema.js";
import { callStructuredStage, type SynthesisStageDeps } from "./geminiStage.js";
import type { StrategyInstanceRecord } from "./normalize.js";
import { CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA, CoreFrameworkSchema, type CanonicalStrategy, type CoreFramework } from "./schema.js";

/**
 * Stage 4 — course-wide principle extraction. Runs AFTER canonical
 * strategies exist, but reasons across them rather than duplicating their
 * content: pools rules from the categories that tend to recur across
 * different strategies regardless of cluster (market context, confirmation,
 * stop-loss, profit-target, trade management, no-trade conditions) from
 * EVERY strategy instance in the course — not just one cluster — plus a
 * condensed view of the canonical strategies for context. Setup/entry/
 * invalidation/visual-discretionary rules are left to the canonical
 * strategies themselves, where they're genuinely strategy-specific.
 */
const CROSS_STRATEGY_CATEGORIES = [
  "market_context_rules",
  "confirmation_rules",
  "stop_loss_rules",
  "profit_target_rules",
  "trade_management_rules",
  "no_trade_conditions",
] as const satisfies readonly (keyof StrategyInstanceRecord["strategy"])[];

interface PooledRule {
  category: string;
  lessonId: number;
  lessonTitle: string;
  strategyInstanceId: number;
  rule: Rule;
}

export async function extractCoreFramework(
  deps: SynthesisStageDeps,
  canonicalStrategies: CanonicalStrategy[],
  allInstances: StrategyInstanceRecord[],
): Promise<{ coreFramework: CoreFramework; usage: GeminiUsage }> {
  const pooled = poolCrossStrategyRules(allInstances);
  const prompt = buildPrompt(canonicalStrategies, pooled);
  const { data, usage } = await callStructuredStage(
    deps,
    "core_framework",
    prompt,
    CORE_FRAMEWORK_RESPONSE_JSON_SCHEMA,
    CoreFrameworkSchema,
  );
  return { coreFramework: data, usage };
}

function poolCrossStrategyRules(instances: StrategyInstanceRecord[]): PooledRule[] {
  const pooled: PooledRule[] = [];
  for (const instance of instances) {
    for (const category of CROSS_STRATEGY_CATEGORIES) {
      for (const rule of instance.strategy[category]) {
        pooled.push({
          category,
          lessonId: instance.lessonId,
          lessonTitle: instance.lessonTitle,
          strategyInstanceId: instance.strategyInstanceId,
          rule,
        });
      }
    }
  }
  return pooled;
}

function buildPrompt(canonicalStrategies: CanonicalStrategy[], pooled: PooledRule[]): string {
  const condensedStrategies = canonicalStrategies.map((s) => ({
    name: s.name,
    purpose: s.purpose,
    markets: s.markets,
    timeframes: s.timeframes,
  }));

  return `You are extracting a course-wide "Core Trading Framework" from a trading course — principles that recur ACROSS multiple strategies, not the strategies themselves.

The canonical strategies already synthesized for this course (for context only, do not restate their strategy-specific setup/entry rules):
${JSON.stringify(condensedStrategies, null, 2)}

Pooled rules from every lesson's market-context, confirmation, stop-loss, profit-target, trade-management, and no-trade categories (the categories most likely to contain course-wide, not strategy-specific, principles):
${JSON.stringify(pooled, null, 2)}

Group these into framework sections such as: Market Preparation, Higher-Timeframe Analysis, Market Regime, Key-Level Identification, Liquidity/Structure, Setup Qualification, Confirmation Framework, Risk Framework, Position/Stop Framework, Target Framework, Trade Management Framework, No-Trade Framework — only include sections that the pooled rules actually support with evidence. Do NOT duplicate a rule into a section it doesn't belong in just to fill every section.

Every rule in your output must carry "sources" (lessonId/lessonTitle/strategyInstanceId/timestamps/evidence) drawn from the pooled rules above, and a "supportLevel" derived from how many distinct lessons actually support it (SINGLE_SOURCE, MULTI_SOURCE, REPEATED_EXPLICIT, VARIANT, CONFLICTING, or INFERRED) — never a fabricated confidence score. Record genuine contradictions with supportLevel CONFLICTING and populate conflictSources, rather than picking a side.

Respond ONLY with JSON matching the required schema.`;
}
