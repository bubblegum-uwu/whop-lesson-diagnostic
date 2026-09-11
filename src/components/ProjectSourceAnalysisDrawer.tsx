import type { YouTubeProjectSource, DiscordProjectSource } from "../lib/sourcesApi";
import type { ProjectSourceAnalysis, ProjectSourceAnalysisJob } from "../lib/projectSourceAnalysisApi";
import { isKnowledgeItemScoped, type KnowledgeCategory, type KnowledgeItem, type LessonExample, type LessonKnowledge } from "../lib/courseApi";

export interface ProjectSourceAnalysisDrawerProps {
  /** null closes the drawer. */
  source: YouTubeProjectSource | DiscordProjectSource | null;
  job: ProjectSourceAnalysisJob | null;
  analysis: ProjectSourceAnalysis | null;
  loading: boolean;
  onClose: () => void;
}

/**
 * Phase 4H-B — the YouTube counterpart to LessonDetailDrawer, reusing the
 * SAME Phase 3.5A types (KnowledgeItem/LessonKnowledge/etc, imported from
 * lib/courseApi.ts unchanged) and the SAME visual language (knowledge-
 * section/rule-item/badge/mono-box CSS classes already defined for the
 * Whop drawer) — a NEW, separate component rather than a modification of
 * LessonDetailDrawer.tsx, so the existing Whop lesson UI/tests are
 * completely unaffected. Deliberately simpler than the full 15-category
 * Whop drawer (no Instructor Heuristics/Conflicts breakout) while still
 * exposing every category of Phase 3.5A content. Never shows a fake
 * lesson/course identity — the header reads "YouTube Video" or "Discord
 * Video" per source.provider (Phase 4I), never a fabricated one.
 */

const PROVIDER_LABELS = { YOUTUBE: "YouTube Video", DISCORD: "Discord Video" } as const;
const PROVIDER_LINK_LABELS = { YOUTUBE: "Open on YouTube", DISCORD: "Open Attachment" } as const;

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
  strategy_name?: string;
  market_or_instrument?: string[];
  timeframes?: string[];
  indicators?: string[];
  entry_rules?: { description: string; start_timestamp: string; end_timestamp: string | null; evidence: string }[];
  [key: string]: unknown;
}

function Section({ title, isEmpty, children }: { title: string; isEmpty: boolean; children: React.ReactNode }) {
  if (isEmpty) return null;
  return (
    <div className="knowledge-section">
      <h3 className="knowledge-section-title">{title}</h3>
      {children}
    </div>
  );
}

function numericalValueLabel(n: KnowledgeItem["numericalValues"][number]): string {
  return n.rawText || `${n.value}${n.value2 != null ? `–${n.value2}` : ""}${n.unit}`;
}

const ILLUSTRATIVE_NUMERICAL_ROLES = new Set<KnowledgeItem["numericalValues"][number]["role"]>(["EXAMPLE", "DERIVED_EXAMPLE"]);

function scopeSummary(scope: KnowledgeItem["scope"]): string | null {
  if (!isKnowledgeItemScoped(scope)) return null;
  return [...scope.strategies, ...scope.marketsOrInstruments, ...scope.timeframes, ...scope.sessions, ...scope.traderProfiles].join(", ");
}

function KnowledgeItemCard({ item }: { item: KnowledgeItem }) {
  const scopeText = scopeSummary(item.scope);
  return (
    <li className="rule-item">
      <div className="rule-header">
        <span className={`badge badge-ruletype-${item.ruleType.toLowerCase()}`}>{RULE_TYPE_LABELS[item.ruleType]}</span>
        <span className={`badge badge-${item.classification}`}>{item.classification}</span>
        {scopeText && (
          <span className="badge badge-scope-scoped" title={scopeText}>
            Scoped: {scopeText}
          </span>
        )}
        <span className="timestamp">
          {item.start_timestamp}
          {item.end_timestamp ? ` – ${item.end_timestamp}` : ""}
        </span>
      </div>
      <p className="rule-description">{item.statement}</p>
      {item.numericalValues.length > 0 && (
        <p className="rule-numerical-values">
          {item.numericalValues.map((n, i) => (
            <span key={i} className={`mono-box${ILLUSTRATIVE_NUMERICAL_ROLES.has(n.role) ? " mono-box-illustrative" : ""}`} title={n.context}>
              {numericalValueLabel(n)} ({n.metric})
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
        <span className="timestamp">
          {example.start_timestamp}
          {example.end_timestamp ? ` – ${example.end_timestamp}` : ""}
        </span>
      </div>
      <p className="rule-description">{example.description}</p>
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export function ProjectSourceAnalysisDrawer({ source, job, analysis, loading, onClose }: ProjectSourceAnalysisDrawerProps) {
  if (!source) return null;

  const validated = analysis?.validatedJson;
  const knowledge = validated?.knowledge as LessonKnowledge | undefined;
  const strategies = (validated?.strategies as Rule[] | undefined) ?? [];
  const title = source.title ?? source.sourceUrl;

  const knowledgeItemsByCategory = new Map<KnowledgeCategory, KnowledgeItem[]>();
  for (const item of (knowledge?.knowledgeItems ?? []) as KnowledgeItem[]) {
    const existing = knowledgeItemsByCategory.get(item.category) ?? [];
    existing.push(item);
    knowledgeItemsByCategory.set(item.category, existing);
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="lesson-drawer" role="dialog" aria-modal="true" aria-label={`Analysis for ${title}`}>
        <div className="drawer-header">
          <div>
            <p className="knovera-youtube-source-label">{PROVIDER_LABELS[source.provider]}</p>
            <h2 className="drawer-title">{title}</h2>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="Close analysis panel">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          <dl className="drawer-meta-grid">
            <dt>Status</dt>
            <dd>{job?.status ?? (analysis ? "COMPLETED" : "Not analyzed")}</dd>
            <dt>Processing time</dt>
            <dd>{formatProcessingTime(analysis?.processingDurationSeconds)}</dd>
            <dt>Cost</dt>
            <dd>{formatCost(analysis?.estimatedCost)}</dd>
            <dt>Last analyzed</dt>
            <dd>{formatDate(analysis?.completedAt)}</dd>
            <dt>Strategy Found</dt>
            <dd>{!analysis ? "—" : analysis.strategyFound ? "Yes" : "No Standalone Setup"}</dd>
          </dl>

          {analysis?.analysisSummary && <p className="drawer-summary">{analysis.analysisSummary}</p>}

          <div className="detail-actions">
            <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="link-button">
              {PROVIDER_LINK_LABELS[source.provider]}
            </a>
          </div>

          {loading && <p className="hint">Loading analysis…</p>}
          {!loading && job?.status === "FAILED" && (
            <div className="error-box">{job.sanitizedError ?? "Analysis failed."}</div>
          )}
          {!loading && !analysis && job?.status !== "FAILED" && <p className="hint">No analysis available yet.</p>}

          {!loading && analysis && (
            <>
              <Section title="Strategies" isEmpty={!analysis.strategyFound || strategies.length === 0}>
                {strategies.map((strategy, i) => (
                  <div className="strategy-card" key={i}>
                    <h3>{strategy.strategy_name as string}</h3>
                    <div className="strategy-meta">
                      <span>Markets: {(strategy.market_or_instrument as string[] | undefined)?.join(", ") || "—"}</span>
                      <span>Timeframes: {(strategy.timeframes as string[] | undefined)?.join(", ") || "—"}</span>
                    </div>
                    {(strategy.entry_rules ?? []).length > 0 && (
                      <div className="rule-section">
                        <h4>Entry</h4>
                        <ul className="rule-list">
                          {(strategy.entry_rules ?? []).map((rule, j) => (
                            <li key={j} className="rule-item">
                              <div className="rule-header">
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
                      </div>
                    )}
                  </div>
                ))}
              </Section>

              {(!analysis.strategyFound || strategies.length === 0) && (
                <div className="no-strategy-box">No Standalone Setup — this video doesn't teach a complete, executable trading setup on its own.</div>
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

              <Section title="Examples" isEmpty={(knowledge?.examples.length ?? 0) === 0}>
                <ul className="rule-list">{knowledge?.examples.map((example, i) => <ExampleCard key={i} example={example} />)}</ul>
              </Section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
