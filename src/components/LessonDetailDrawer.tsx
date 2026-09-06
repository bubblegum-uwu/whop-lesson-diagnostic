import { useEffect, useState } from "react";
import type { CourseLessonSummary } from "../lib/courseApi";
import { StatusBadge } from "./StatusBadge";

export interface LessonDetailDrawerProps {
  /** null closes the drawer. */
  lesson: CourseLessonSummary | null;
  onClose: () => void;
  /** Fetches the full validated JSON for this lesson's latest analysis, lazily, once the drawer opens. */
  onLoadAnalysis: (lessonId: number) => Promise<unknown | null>;
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

interface ValidatedAnalysis {
  strategy_found: boolean;
  strategies: Strategy[];
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

function formatCost(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

function formatProcessingTime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function CopyJsonButton({ json }: { json: unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={async () => {
        await navigator.clipboard.writeText(JSON.stringify(json, null, 2));
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy JSON"}
    </button>
  );
}

/**
 * The lesson detail SIDE DRAWER — replaces the old in-row <tr> expansion.
 * Opening one lesson never changes the height/position of any table row;
 * the table stays exactly where it was. Reuses the same strategy/rule
 * rendering that used to live in AnalysisDetailPanel, unchanged.
 */
export function LessonDetailDrawer({ lesson, onClose, onLoadAnalysis }: LessonDetailDrawerProps) {
  const [validatedJson, setValidatedJson] = useState<unknown | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!lesson) {
      setValidatedJson(null);
      return;
    }
    let cancelled = false;
    setValidatedJson(null);
    setLoading(true);
    onLoadAnalysis(lesson.id)
      .then((json) => {
        if (!cancelled) setValidatedJson(json);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.id]);

  useEffect(() => {
    if (!lesson) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [lesson, onClose]);

  if (!lesson) return null;

  const job = lesson.job ?? { jobId: null, status: "NOT_ANALYZED" as const };
  const analysis = lesson.analysis ?? null;
  const parsed = validatedJson as ValidatedAnalysis | null;

  const strategyFoundLabel = !analysis
    ? "—"
    : !analysis.strategyFound
      ? "No"
      : (parsed?.strategies.length ?? 0) > 1
        ? "Multiple"
        : "Yes";

  const strategyNames = parsed?.strategy_found ? parsed.strategies.map((s) => s.strategy_name) : [];

  function downloadJson() {
    if (validatedJson == null || !lesson) return;
    const blob = new Blob([JSON.stringify(validatedJson, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lesson.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-analysis.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="lesson-drawer" role="dialog" aria-modal="true" aria-label={`Analysis for ${lesson.title}`}>
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">{lesson.title}</h2>
            <p className="drawer-subtitle">
              {lesson.chapterTitle ?? "—"} · {formatDuration(lesson.durationSeconds)}
            </p>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close analysis panel">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <dl className="drawer-meta-grid">
            <dt>Status</dt>
            <dd>
              <StatusBadge status={job.status} />
            </dd>
            <dt>Processing time</dt>
            <dd>{formatProcessingTime(analysis?.processingDurationSeconds)}</dd>
            <dt>Cost</dt>
            <dd>{formatCost(analysis?.estimatedCost)}</dd>
            <dt>Last analyzed</dt>
            <dd>{formatDate(analysis?.completedAt)}</dd>
            <dt>Strategy Found</dt>
            <dd>{strategyFoundLabel}</dd>
            <dt>Confidence</dt>
            <dd>{formatConfidence(analysis?.confidence)}</dd>
          </dl>

          {analysis && analysis.ruleCounts.length > 0 && (
            <div className="drawer-rule-counts">
              {analysis.ruleCounts.map((r) => (
                <span key={r.label} className="mono-box">
                  {r.label} {r.count}
                </span>
              ))}
            </div>
          )}

          {analysis?.summary && <p className="drawer-summary">{analysis.summary}</p>}

          <div className="detail-actions">
            <a href={lesson.sourceUrl} target="_blank" rel="noreferrer">
              Open Source
            </a>
            <button className="link-button" onClick={downloadJson} disabled={!validatedJson}>
              Download JSON
            </button>
          </div>

          {loading && <p className="hint">Loading analysis…</p>}
          {!loading && !validatedJson && <p className="hint">No analysis available yet.</p>}

          {!loading && parsed != null && (
            <>
              {strategyNames.length > 1 && (
                <ul className="plain-list drawer-strategy-names">
                  {strategyNames.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              )}

              {!parsed.strategy_found || parsed.strategies.length === 0 ? (
                <div className="no-strategy-box">No concrete trading strategy taught.</div>
              ) : (
                parsed.strategies.map((strategy, i) => <StrategyDetail key={i} strategy={strategy} />)
              )}
            </>
          )}

          {!loading && validatedJson != null && (
            <details className="setup-disclosure raw-json-disclosure">
              <summary>▶ Raw JSON</summary>
              <div className="raw-json-actions">
                <CopyJsonButton json={validatedJson} />
                <button className="link-button" onClick={downloadJson}>
                  Download JSON
                </button>
              </div>
              <pre className="json-block json-block-scroll">{JSON.stringify(validatedJson, null, 2)}</pre>
            </details>
          )}
        </div>
      </div>
    </>
  );
}
