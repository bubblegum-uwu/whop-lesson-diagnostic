import type { CourseLessonSummary } from "../lib/courseApi";

export interface AnalysisDetailPanelProps {
  lesson: CourseLessonSummary;
  validatedJson: unknown | null;
  loading: boolean;
  onDownloadJson: () => void;
}

const RULE_SECTIONS: { key: string; label: string }[] = [
  { key: "setup_conditions", label: "Setup" },
  { key: "entry_rules", label: "Entry" },
  { key: "confirmation_rules", label: "Confirmation" },
  { key: "stop_loss_rules", label: "Stop Loss" },
  { key: "profit_target_rules", label: "Profit Target" },
  { key: "trade_management_rules", label: "Trade Management" },
  { key: "invalidation_rules", label: "Invalidation" },
  { key: "no_trade_conditions", label: "No-Trade Conditions" },
  { key: "market_context_rules", label: "Market Context" },
  { key: "visual_discretionary_rules", label: "Visual / Discretionary" },
];

interface Rule {
  description: string;
  classification: "explicit" | "inferred" | "visual";
  confidence: number;
  start_timestamp: string;
  end_timestamp: string | null;
  evidence: string;
}

interface Strategy {
  strategy_name: string;
  market_or_instrument: string[];
  timeframes: string[];
  indicators: string[];
  examples_shown: string[];
  ambiguities: string[];
  [key: string]: unknown;
}

function RuleList({ rules }: { rules: Rule[] }) {
  if (rules.length === 0) return <p className="rule-empty">None identified.</p>;
  return (
    <ul className="rule-list">
      {rules.map((rule, i) => (
        <li key={i} className="rule-item">
          <div className="rule-header">
            <span className={`badge badge-${rule.classification}`}>{rule.classification}</span>
            <span className="confidence">{Math.round(rule.confidence * 100)}% confidence</span>
            <span className="timestamp">
              {rule.start_timestamp}
              {rule.end_timestamp ? ` – ${rule.end_timestamp}` : ""}
            </span>
          </div>
          <p className="rule-description">{rule.description}</p>
          <p className="rule-evidence">{rule.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

function StrategyDetail({ strategy }: { strategy: Strategy }) {
  return (
    <div className="strategy-card">
      <h3>{strategy.strategy_name}</h3>
      <div className="strategy-meta">
        <span>Markets: {strategy.market_or_instrument.join(", ") || "—"}</span>
        <span>Timeframes: {strategy.timeframes.join(", ") || "—"}</span>
        <span>Indicators: {strategy.indicators.join(", ") || "—"}</span>
      </div>
      {RULE_SECTIONS.map(({ key, label }) => (
        <div className="rule-section" key={key}>
          <h4>{label}</h4>
          <RuleList rules={(strategy[key] as Rule[]) ?? []} />
        </div>
      ))}
      {strategy.examples_shown.length > 0 && (
        <div className="rule-section">
          <h4>Examples Shown</h4>
          <ul className="plain-list">
            {strategy.examples_shown.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {strategy.ambiguities.length > 0 && (
        <div className="rule-section">
          <h4>Ambiguities</h4>
          <ul className="plain-list">
            {strategy.ambiguities.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The [ View Analysis ] expandable row detail — full validated JSON, rendered, never re-derived via a Gemini call. */
export function AnalysisDetailPanel({ lesson, validatedJson, loading, onDownloadJson }: AnalysisDetailPanelProps) {
  return (
    <div className="analysis-detail-panel">
      <div className="detail-actions">
        <a href={lesson.sourceUrl} target="_blank" rel="noreferrer">
          Open Source
        </a>
        <button className="link-button" onClick={onDownloadJson} disabled={!validatedJson}>
          Download JSON
        </button>
      </div>

      {loading && <p className="hint">Loading analysis…</p>}
      {!loading && !validatedJson && <p className="hint">No analysis available yet.</p>}

      {!loading &&
        validatedJson != null &&
        (() => {
          const analysis = validatedJson as { strategy_found: boolean; strategies: Strategy[] };
          if (!analysis.strategy_found || analysis.strategies.length === 0) {
            return <div className="no-strategy-box">No concrete trading strategy taught.</div>;
          }
          return analysis.strategies.map((strategy, i) => <StrategyDetail key={i} strategy={strategy} />);
        })()}

      {!loading && validatedJson != null && (
        <details className="setup-disclosure">
          <summary>View raw JSON</summary>
          <pre className="json-block">{JSON.stringify(validatedJson, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
