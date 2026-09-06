import { useEffect, useState } from "react";
import type { CourseLessonSummary, KnowledgeCategory, KnowledgeItem, LessonExample, LessonKnowledge } from "../lib/courseApi";
import { isKnowledgeItemScoped } from "../lib/courseApi";
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

/** Display order + labels for the Phase 3.5 knowledge categories — "Overview"/"Strategies"/"Examples"/"Sources" aren't in this map, since they're handled as their own dedicated sections below, not grouped knowledgeItems. */
const KNOWLEDGE_CATEGORY_SECTIONS: { key: KnowledgeCategory; label: string }[] = [
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
  { key: "no_trade_conditions", label: "No-Trade Rules" },
  { key: "warnings", label: "Warnings" },
  { key: "definitions", label: "Definitions" },
];

const RULE_TYPE_LABELS: Record<KnowledgeItem["ruleType"], string> = {
  HARD_RULE: "Hard Rule",
  GUIDELINE: "Guideline",
  PREFERENCE: "Preference",
  WARNING: "Warning",
  PROHIBITION: "Prohibition",
  DEFINITION: "Definition",
  OBSERVATION: "Observation",
};

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
  knowledge: LessonKnowledge;
}

/** Wraps a section so an empty one renders nothing at all — the drawer's one enforcement point for "hide empty sections," rather than every section re-implementing its own empty check. */
function Section({ title, isEmpty, children }: { title: string; isEmpty: boolean; children: React.ReactNode }) {
  if (isEmpty) return null;
  return (
    <div className="knowledge-section">
      <h3 className="knowledge-section-title">{title}</h3>
      {children}
    </div>
  );
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

/** "at least 2R" / "1% to 5%" — falls back to a computed value+unit only for older data that lacks rawText. */
function numericalValueLabel(n: KnowledgeItem["numericalValues"][number]): string {
  return n.rawText || `${n.value}${n.value2 != null ? `–${n.value2}` : ""}${n.unit}`;
}

/** EXAMPLE/DERIVED_EXAMPLE numbers illustrate one instance and must never be read as a universal rule — flagged distinctly from RULE_THRESHOLD/GUIDELINE. */
const ILLUSTRATIVE_NUMERICAL_ROLES = new Set<KnowledgeItem["numericalValues"][number]["role"]>(["EXAMPLE", "DERIVED_EXAMPLE"]);

function scopeSummary(scope: KnowledgeItem["scope"]): string | null {
  if (!isKnowledgeItemScoped(scope)) return null;
  const parts = [...scope.strategies, ...scope.marketsOrInstruments, ...scope.timeframes, ...scope.sessions, ...scope.traderProfiles];
  return parts.join(", ");
}

function KnowledgeItemCard({ item, showCategory = false }: { item: KnowledgeItem; showCategory?: boolean }) {
  const scopeText = scopeSummary(item.scope);
  return (
    <li className="rule-item">
      <div className="rule-header">
        <span className={`badge badge-ruletype-${item.ruleType.toLowerCase()}`}>{RULE_TYPE_LABELS[item.ruleType]}</span>
        <span className={`badge badge-${item.classification}`}>{item.classification}</span>
        {showCategory && <span className="badge badge-category">{item.category.replace(/_/g, " ")}</span>}
        {scopeText && (
          <span className="badge badge-scope-scoped" title={scopeText}>
            Scoped: {scopeText}
          </span>
        )}
        <span className="confidence">{Math.round(item.confidence * 100)}% confidence</span>
        <span className="timestamp">
          {item.start_timestamp}
          {item.end_timestamp ? ` – ${item.end_timestamp}` : ""}
        </span>
      </div>
      <p className="rule-description">{item.statement}</p>
      {item.conditions && <p className="rule-conditions">When: {item.conditions}</p>}
      {item.exceptions.length > 0 && (
        <p className="rule-conditions">Except: {item.exceptions.join("; ")}</p>
      )}
      {item.numericalValues.length > 0 && (
        <p className="rule-numerical-values">
          {item.numericalValues.map((n, i) => (
            <span key={i} className={`mono-box${ILLUSTRATIVE_NUMERICAL_ROLES.has(n.role) ? " mono-box-illustrative" : ""}`} title={n.context}>
              {numericalValueLabel(n)} ({n.metric}{ILLUSTRATIVE_NUMERICAL_ROLES.has(n.role) ? `, ${n.role === "DERIVED_EXAMPLE" ? "derived example" : "example"}` : ""})
            </span>
          ))}
        </p>
      )}
      <p className="rule-evidence">{item.evidence}</p>
    </li>
  );
}

function ExampleCard({ example }: { example: LessonExample }) {
  return (
    <li className="rule-item">
      <div className="rule-header">
        {example.illustratesCategory && <span className="badge badge-category">{example.illustratesCategory.replace(/_/g, " ")}</span>}
        <span className="timestamp">
          {example.start_timestamp}
          {example.end_timestamp ? ` – ${example.end_timestamp}` : ""}
        </span>
      </div>
      <p className="rule-description">{example.description}</p>
      {example.outcome && <p className="rule-conditions">Outcome: {example.outcome}</p>}
      <p className="rule-evidence">{example.evidence}</p>
    </li>
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
 * the table stays exactly where it was.
 *
 * Phase 3.5: organizes the richer per-lesson analysis into readable
 * sections (Overview / Strategies / Market Context / Risk Management /
 * Position Sizing / Scaling In / Scaling Out / Trade Management /
 * Execution / Higher Timeframe / Preparation / Psychology / No-Trade
 * Rules / Warnings / Definitions / Numerical Rules / Examples /
 * Instructor Heuristics), each hidden entirely when empty — never a raw
 * JSON dump as the primary presentation (raw JSON stays available in the
 * collapsed "Raw JSON" disclosure at the bottom, unchanged). A "Sources"
 * section is deliberately not a separate block here: for a single
 * lesson's own analysis there is nothing to show beyond the lesson's own
 * "Open Source" link already in the header actions — every item's own
 * timestamp/evidence already IS its source within this one lesson.
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
  const knowledge = parsed?.knowledge ?? null;

  const strategyFoundLabel = !analysis
    ? "—"
    : !analysis.strategyFound
      ? "No Standalone Setup"
      : (parsed?.strategies.length ?? 0) > 1
        ? "Multiple"
        : "Yes";

  const strategyNames = parsed?.strategy_found ? parsed.strategies.map((s) => s.strategy_name) : [];

  // A PREFERENCE item lives ONLY in "Instructor Heuristics" below, never
  // also under its own category — otherwise the exact same item would
  // render twice (once generically, once specifically flagged as a
  // preference), which reads as duplicated content, not two distinct facts.
  const knowledgeItemsByCategory = new Map<KnowledgeCategory, KnowledgeItem[]>();
  for (const item of knowledge?.knowledgeItems ?? []) {
    if (item.ruleType === "PREFERENCE") continue;
    const existing = knowledgeItemsByCategory.get(item.category) ?? [];
    existing.push(item);
    knowledgeItemsByCategory.set(item.category, existing);
  }
  const preferenceHeuristics = (knowledge?.knowledgeItems ?? []).filter((i) => i.ruleType === "PREFERENCE");
  const allNumericalValues = (knowledge?.knowledgeItems ?? []).flatMap((item) =>
    item.numericalValues.map((n) => ({ item, numericalValue: n })),
  );

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
              {/* Skipped whenever it would just repeat the always-visible summary
                  line above (shown instantly from `analysis.summary`, before this
                  JSON loads) — for a no-strategy lesson the two are the same text
                  (see pipeline/analysisSummary.ts's buildAnalysisSummary), so this
                  only actually adds new information when a strategy WAS found
                  (analysis.summary is then the strategy-specific synopsis, while
                  this is the lesson's general themes/objectives). */}
              <Section
                title="Overview"
                isEmpty={!knowledge?.summary || knowledge.summary.trim() === (analysis?.summary ?? "").trim()}
              >
                <p className="drawer-summary">{knowledge?.summary}</p>
              </Section>

              <Section title="Strategies" isEmpty={!parsed.strategy_found || parsed.strategies.length === 0}>
                {strategyNames.length > 1 && (
                  <ul className="plain-list drawer-strategy-names">
                    {strategyNames.map((name, i) => (
                      <li key={i}>{name}</li>
                    ))}
                  </ul>
                )}
                {parsed.strategies.map((strategy, i) => (
                  <StrategyDetail key={i} strategy={strategy} />
                ))}
              </Section>

              {(!parsed.strategy_found || parsed.strategies.length === 0) && (
                <div className="no-strategy-box">
                  No Standalone Setup — this lesson doesn't teach a complete, executable trading setup on its own.
                  {analysis?.hasSupportingKnowledge && " It still contains supporting knowledge, captured in the sections below."}
                </div>
              )}

              {KNOWLEDGE_CATEGORY_SECTIONS.map(({ key, label }) => {
                const items = knowledgeItemsByCategory.get(key) ?? [];
                return (
                  <Section key={key} title={label} isEmpty={items.length === 0}>
                    <ul className="rule-list">
                      {items.map((item, i) => (
                        <KnowledgeItemCard key={i} item={item} />
                      ))}
                    </ul>
                  </Section>
                );
              })}

              <Section title="Numerical Rules" isEmpty={allNumericalValues.length === 0}>
                <ul className="rule-list">
                  {allNumericalValues.map(({ item, numericalValue }, i) => (
                    <li key={i} className="rule-item">
                      <div className="rule-header">
                        <span className={`mono-box${ILLUSTRATIVE_NUMERICAL_ROLES.has(numericalValue.role) ? " mono-box-illustrative" : ""}`}>
                          {numericalValueLabel(numericalValue)}
                        </span>
                        <span className="badge badge-category">{item.category.replace(/_/g, " ")}</span>
                        <span className="badge badge-category">{numericalValue.role.replace(/_/g, " ").toLowerCase()}</span>
                      </div>
                      <p className="rule-description">{numericalValue.context}</p>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="Examples" isEmpty={(knowledge?.examples.length ?? 0) === 0}>
                <ul className="rule-list">
                  {knowledge?.examples.map((example, i) => (
                    <ExampleCard key={i} example={example} />
                  ))}
                </ul>
              </Section>

              <Section title="Instructor Heuristics" isEmpty={preferenceHeuristics.length === 0}>
                <ul className="rule-list">
                  {preferenceHeuristics.map((item, i) => (
                    <KnowledgeItemCard key={i} item={item} showCategory />
                  ))}
                </ul>
              </Section>

              <Section title="Conflicts / Ambiguity" isEmpty={(knowledge?.conflictsAndAmbiguities.length ?? 0) === 0}>
                <ul className="plain-list">{knowledge?.conflictsAndAmbiguities.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </Section>
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
