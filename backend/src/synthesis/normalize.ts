import type { Strategy } from "../gemini/schema.js";

/**
 * Stage 1 — normalization. Pure, deterministic, no Gemini call: builds a
 * compact per-instance signature used as clustering input (Stage 2). Full
 * rule bodies are deliberately left out here — clustering only needs enough
 * signal to group similar setups; the full `strategy_instance` JSON is only
 * sent to Gemini once, per cluster, at Stage 3.
 */
export interface StrategyInstanceRecord {
  strategyInstanceId: number;
  lessonId: number;
  lessonTitle: string;
  analysisId: number;
  strategyName: string;
  normalizedName: string;
  strategy: Strategy;
}

export interface StrategySignature {
  strategyInstanceId: number;
  lessonId: number;
  lessonTitle: string;
  originalName: string;
  normalizedName: string;
  markets: string[];
  timeframes: string[];
  indicators: string[];
  ruleCounts: Record<string, number>;
  /** First entry-rule description, if any — the single most identifying phrase for a quick human/model skim. */
  entrySummary: string | null;
}

const RULE_CATEGORIES = [
  "setup_conditions",
  "entry_rules",
  "confirmation_rules",
  "stop_loss_rules",
  "profit_target_rules",
  "trade_management_rules",
  "invalidation_rules",
  "no_trade_conditions",
  "market_context_rules",
  "visual_discretionary_rules",
] as const;

export function buildStrategySignature(record: StrategyInstanceRecord): StrategySignature {
  const ruleCounts: Record<string, number> = {};
  for (const category of RULE_CATEGORIES) {
    ruleCounts[category] = record.strategy[category].length;
  }
  return {
    strategyInstanceId: record.strategyInstanceId,
    lessonId: record.lessonId,
    lessonTitle: record.lessonTitle,
    originalName: record.strategyName,
    normalizedName: record.normalizedName,
    markets: record.strategy.market_or_instrument,
    timeframes: record.strategy.timeframes,
    indicators: record.strategy.indicators,
    ruleCounts,
    entrySummary: record.strategy.entry_rules[0]?.description ?? null,
  };
}

/**
 * Chunks signatures for Stage 2's map step. Never splits one signature
 * across chunks — chunking is purely at the instance boundary. Sized by a
 * cheap token estimate (chars / 4, the same rough heuristic used elsewhere
 * absent a real tokenizer dependency), not a fixed count, so a handful of
 * instances with unusually long entry-rule text don't overflow a batch.
 */
export function chunkSignatures(signatures: StrategySignature[], maxEstimatedTokensPerChunk = 6000): StrategySignature[][] {
  const chunks: StrategySignature[][] = [];
  let current: StrategySignature[] = [];
  let currentTokens = 0;

  for (const signature of signatures) {
    const estimatedTokens = Math.ceil(JSON.stringify(signature).length / 4);
    if (current.length > 0 && currentTokens + estimatedTokens > maxEstimatedTokensPerChunk) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(signature);
    currentTokens += estimatedTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
