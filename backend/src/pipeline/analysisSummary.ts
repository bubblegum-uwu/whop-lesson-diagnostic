import type { LessonStrategyAnalysis, Rule, Strategy } from "../gemini/schema.js";

/**
 * Everything here is derived deterministically from the already-validated
 * Gemini JSON — no additional Gemini call is ever made to produce a summary,
 * confidence score, or rule count. "Confidence" is deliberately only ever an
 * average of the model's own per-rule confidence values; this file never
 * invents a separate model-confidence metric.
 */

const RULE_CATEGORIES: { key: keyof Strategy; label: string }[] = [
  { key: "setup_conditions", label: "Setup" },
  { key: "entry_rules", label: "Entry" },
  { key: "confirmation_rules", label: "Confirmation" },
  { key: "stop_loss_rules", label: "Stops" },
  { key: "profit_target_rules", label: "Targets" },
  { key: "trade_management_rules", label: "Management" },
  { key: "invalidation_rules", label: "Invalidation" },
  { key: "no_trade_conditions", label: "No-Trade" },
  { key: "market_context_rules", label: "Market Context" },
  { key: "visual_discretionary_rules", label: "Visual" },
];

function allRules(strategy: Strategy): Rule[] {
  return RULE_CATEGORIES.flatMap(({ key }) => strategy[key] as Rule[]);
}

export interface RuleCount {
  label: string;
  count: number;
}

/** Non-zero categories only, in a stable display order — e.g. "Setup 3, Entry 2, Stops 1". */
export function ruleCounts(analysis: LessonStrategyAnalysis): RuleCount[] {
  const totals = new Map<string, number>();
  for (const strategy of analysis.strategies) {
    for (const { key, label } of RULE_CATEGORIES) {
      const rules = strategy[key] as Rule[];
      totals.set(label, (totals.get(label) ?? 0) + rules.length);
    }
  }
  return RULE_CATEGORIES.map(({ label }) => ({ label, count: totals.get(label) ?? 0 })).filter(
    (r) => r.count > 0,
  );
}

/** Mean of every rule's confidence across every strategy, or null if there are no rules at all. */
export function aggregateConfidence(analysis: LessonStrategyAnalysis): number | null {
  const confidences = analysis.strategies.flatMap((s) => allRules(s).map((r) => r.confidence));
  if (confidences.length === 0) return null;
  const sum = confidences.reduce((a, b) => a + b, 0);
  return Math.round((sum / confidences.length) * 100) / 100;
}

/** "Break & Retest" | "Break & Retest +2 more" | null (no strategy found). */
export function extractedStrategiesLabel(analysis: LessonStrategyAnalysis): string | null {
  if (!analysis.strategy_found || analysis.strategies.length === 0) return null;
  const [first, ...rest] = analysis.strategies;
  return rest.length > 0 ? `${first.strategy_name} +${rest.length} more` : first.strategy_name;
}

function summarizeStrategy(strategy: Strategy): string {
  const parts: string[] = [strategy.strategy_name];
  if (strategy.indicators.length > 0) {
    parts.push(`using ${strategy.indicators.slice(0, 3).join(", ")}`);
  }
  const entry = strategy.entry_rules[0]?.description;
  if (entry) parts.push(`entry: ${entry}`);
  const stop = strategy.stop_loss_rules[0]?.description;
  if (stop) parts.push(`stop: ${stop}`);
  const target = strategy.profit_target_rules[0]?.description;
  if (target) parts.push(`target: ${target}`);
  return parts.join(", ");
}

/**
 * A short, deterministic, template-built summary — never an extra Gemini
 * call. E.g. "Break & Retest using HTF levels, displacement, entry: retest
 * entry, stop: market-structure stop, target: next-key-level targets."
 */
export function buildAnalysisSummary(analysis: LessonStrategyAnalysis): string {
  if (!analysis.strategy_found || analysis.strategies.length === 0) {
    return "No concrete trading strategy taught.";
  }
  const summaries = analysis.strategies.map(summarizeStrategy);
  return summaries.join("; ");
}
