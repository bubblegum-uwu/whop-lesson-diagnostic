export interface StrategyRule {
  description: string;
  classification: "explicit" | "inferred" | "visual";
  confidence: number;
  start_timestamp: string;
  end_timestamp: string | null;
  evidence: string;
}

export interface Strategy {
  strategy_name: string;
  market_or_instrument: string[];
  timeframes: string[];
  indicators: string[];
  setup_conditions: StrategyRule[];
  entry_rules: StrategyRule[];
  confirmation_rules: StrategyRule[];
  stop_loss_rules: StrategyRule[];
  profit_target_rules: StrategyRule[];
  trade_management_rules: StrategyRule[];
  invalidation_rules: StrategyRule[];
  no_trade_conditions: StrategyRule[];
  market_context_rules: StrategyRule[];
  visual_discretionary_rules: StrategyRule[];
  examples_shown: string[];
  ambiguities: string[];
}

export interface LessonStrategyAnalysis {
  lesson: { title: string; duration_seconds: number | null };
  strategy_found: boolean;
  strategies: Strategy[];
}

export const RULE_SECTIONS: Array<{ key: keyof Strategy; label: string }> = [
  { key: "setup_conditions", label: "Setup conditions" },
  { key: "entry_rules", label: "Entry rules" },
  { key: "confirmation_rules", label: "Confirmation rules" },
  { key: "stop_loss_rules", label: "Stop loss rules" },
  { key: "profit_target_rules", label: "Profit target rules" },
  { key: "trade_management_rules", label: "Trade management rules" },
  { key: "invalidation_rules", label: "Invalidation rules" },
  { key: "no_trade_conditions", label: "No-trade conditions" },
  { key: "market_context_rules", label: "Market context rules" },
  { key: "visual_discretionary_rules", label: "Visual / discretionary rules" },
];
