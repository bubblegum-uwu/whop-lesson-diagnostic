import type { LessonStrategyAnalysis, Rule, Strategy, KnowledgeCategoryValue } from "../gemini/schema.js";

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
 *
 * Phase 3.5: previously hardcoded to the literal string "No concrete
 * trading strategy taught." whenever strategy_found was false — since
 * every lesson now always carries `knowledge.summary` regardless of
 * strategy_found (see gemini/schema.ts's v2 changelog), a lesson with no
 * standalone strategy but real supporting knowledge (risk management,
 * sizing, psychology, ...) gets ITS OWN real summary here instead of that
 * one hardcoded string — strategy_found=false no longer means "nothing
 * useful to show."
 */
export function buildAnalysisSummary(analysis: LessonStrategyAnalysis): string {
  if (analysis.strategy_found && analysis.strategies.length > 0) {
    return analysis.strategies.map(summarizeStrategy).join("; ");
  }
  const knowledgeSummary = analysis.knowledge.summary.trim();
  return knowledgeSummary.length > 0 ? knowledgeSummary : "No concrete trading strategy or supporting knowledge extracted.";
}

/** Non-zero knowledge categories only, in KNOWLEDGE_CATEGORY_LABELS' stable order — mirrors ruleCounts() above, but for Phase 3.5's category-tagged knowledgeItems rather than per-strategy rule arrays. */
const KNOWLEDGE_CATEGORY_LABELS: { key: KnowledgeCategoryValue; label: string }[] = [
  { key: "market_context", label: "Market Context" },
  { key: "risk_management", label: "Risk Management" },
  { key: "position_sizing", label: "Position Sizing" },
  { key: "scaling_in", label: "Scaling In" },
  { key: "scaling_out", label: "Scaling Out" },
  { key: "trade_management", label: "Trade Management" },
  { key: "execution", label: "Execution" },
  { key: "higher_timeframe", label: "Higher Timeframe" },
  { key: "preparation", label: "Preparation" },
  { key: "psychology", label: "Psychology" },
  { key: "no_trade_conditions", label: "No-Trade Conditions" },
  { key: "warnings", label: "Warnings" },
  { key: "definitions", label: "Definitions" },
];

export function knowledgeItemCounts(analysis: LessonStrategyAnalysis): RuleCount[] {
  const totals = new Map<string, number>();
  for (const item of analysis.knowledge.knowledgeItems) {
    totals.set(item.category, (totals.get(item.category) ?? 0) + 1);
  }
  return KNOWLEDGE_CATEGORY_LABELS.map(({ key, label }) => ({ label, count: totals.get(key) ?? 0 })).filter((r) => r.count > 0);
}

/** True whenever this lesson's analysis carries ANY supporting knowledge beyond a bare strategy — used to distinguish "no standalone setup, but real supporting content" from "genuinely nothing extracted" without re-deriving the same check in every caller. */
export function hasSupportingKnowledge(analysis: LessonStrategyAnalysis): boolean {
  return (
    analysis.knowledge.knowledgeItems.length > 0 ||
    analysis.knowledge.examples.length > 0 ||
    analysis.knowledge.conflictsAndAmbiguities.length > 0 ||
    analysis.knowledge.summary.trim().length > 0
  );
}
