import { useEffect, useState } from "react";
import {
  getSynthesisStatus,
  synthesizeCourse,
  getCourseSynthesis,
  type SynthesisStatus,
  type CourseSynthesisData,
  type CanonicalStrategyInfo,
  type SynthesizedRule,
  type SourceRef,
} from "../lib/synthesisApi";

export interface CourseIntelligenceProps {
  backendUrl: string | null;
  accessToken: string | null;
  connected: boolean;
}

const TABS = ["Overview", "Canonical Strategies", "Core Framework", "Playbook", "Decision Framework", "Conflicts", "Sources"] as const;
type Tab = (typeof TABS)[number];

function formatCost(value: number | null): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

function sourceTitle(sources: SourceRef[]): string {
  return sources.map((s) => `${s.lessonTitle}${s.startTimestamp ? ` @ ${s.startTimestamp}` : ""}: ${s.evidence}`).join("\n");
}

function RuleList({ rules }: { rules: SynthesizedRule[] }) {
  if (rules.length === 0) return <p className="hint">None identified.</p>;
  return (
    <ul className="rule-list">
      {rules.map((rule, i) => (
        <li key={i} className="rule-item">
          <div className="rule-header">
            <span className={`badge badge-${rule.classification === "synthesized" ? "inferred" : rule.classification}`}>{rule.classification}</span>
            <span className={`support-level support-${rule.supportLevel.toLowerCase()}`}>{rule.supportLevel.replace(/_/g, " ")}</span>
            <span className="confidence">{rule.supportCount} lesson(s)</span>
          </div>
          <p className="rule-description" title={sourceTitle(rule.sources)}>
            {rule.description}
          </p>
          {rule.conflictSources.length > 0 && (
            <p className="rule-evidence" title={sourceTitle(rule.conflictSources)}>
              ⚠ Conflicting evidence from {rule.conflictSources.length} source(s)
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function CanonicalStrategyCard({ info }: { info: CanonicalStrategyInfo }) {
  const [expanded, setExpanded] = useState(false);
  const s = info.strategy;
  return (
    <div className="strategy-card">
      <div className="strategy-result-header">
        <h3>{s.name}</h3>
        <button className="link-button" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Collapse" : "View"}
        </button>
      </div>
      <div className="strategy-meta">
        <span>{s.sourceLessonIds.length} supporting lesson instance(s)</span>
        <span>{s.variants.length} variant(s)</span>
        <span>{s.conflicts.length} conflict(s)</span>
        <span>Markets: {s.markets.join(", ") || "—"}</span>
        <span>Timeframes: {s.timeframes.join(", ") || "—"}</span>
      </div>
      {expanded && (
        <>
          <p className="drawer-summary">{s.purpose}</p>
          <div className="rule-section">
            <h4>Setup</h4>
            <RuleList rules={s.setup} />
          </div>
          <div className="rule-section">
            <h4>Entry</h4>
            <RuleList rules={s.entryRules} />
          </div>
          <div className="rule-section">
            <h4>Confirmation</h4>
            <RuleList rules={s.confirmationRules} />
          </div>
          <div className="rule-section">
            <h4>Stop Loss</h4>
            <RuleList rules={s.stopLossRules} />
          </div>
          <div className="rule-section">
            <h4>Profit Targets</h4>
            <RuleList rules={s.profitTargetRules} />
          </div>
          <div className="rule-section">
            <h4>Trade Management</h4>
            <RuleList rules={s.tradeManagementRules} />
          </div>
          <div className="rule-section">
            <h4>Invalidation</h4>
            <RuleList rules={s.invalidationRules} />
          </div>
          <div className="rule-section">
            <h4>No-Trade Conditions</h4>
            <RuleList rules={s.noTradeConditions} />
          </div>
          {s.variants.length > 0 && (
            <div className="rule-section">
              <h4>Variants</h4>
              <ul className="plain-list">
                {s.variants.map((v, i) => (
                  <li key={i}>{v.description}</li>
                ))}
              </ul>
            </div>
          )}
          {s.conflicts.length > 0 && (
            <div className="rule-section">
              <h4>Conflicts</h4>
              <ul className="plain-list">
                {s.conflicts.map((c, i) => (
                  <li key={i} title={sourceTitle(c.sources)}>
                    {c.description}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.ambiguities.length > 0 && (
            <div className="rule-section">
              <h4>Ambiguities</h4>
              <ul className="plain-list">
                {s.ambiguities.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface ConfirmDialogState {
  force: boolean;
  analyzed: number;
  remaining: number;
  total: number;
}

export function CourseIntelligence({ backendUrl, accessToken, connected }: CourseIntelligenceProps) {
  const [status, setStatus] = useState<SynthesisStatus | null>(null);
  const [data, setData] = useState<CourseSynthesisData | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("Overview");
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function refresh() {
    if (!backendUrl || !accessToken) return;
    try {
      const nextStatus = await getSynthesisStatus(backendUrl, accessToken);
      setStatus(nextStatus);
      if (nextStatus?.latestCompletedRun) {
        const nextData = await getCourseSynthesis(backendUrl, accessToken);
        setData(nextData);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load course synthesis.");
    }
  }

  useEffect(() => {
    if (!connected || !backendUrl || !accessToken) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, backendUrl, accessToken]);

  // Poll while a run is in flight — synthesis takes minutes, and the frontend
  // never holds an HTTP request open for it (see backend worker/synthesisLoop.ts).
  useEffect(() => {
    const inFlight = status?.latestRun && (status.latestRun.status === "QUEUED" || status.latestRun.status === "RUNNING");
    if (!inFlight) return undefined;
    const interval = setInterval(() => void refresh(), 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.latestRun?.status, status?.latestRun?.runId]);

  if (!connected || !backendUrl || !accessToken || !status) return null;

  async function doSynthesize(force: boolean) {
    if (!backendUrl || !accessToken) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await synthesizeCourse(backendUrl, accessToken, force);
      await refresh();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to start synthesis.");
    } finally {
      setBusy(false);
      setConfirmDialog(null);
    }
  }

  function handleSynthesizeClick(force: boolean) {
    if (!status) return;
    const remaining = status.counts.processing + status.counts.queued;
    if (remaining > 0) {
      setConfirmDialog({ force, analyzed: status.counts.analyzed, remaining, total: status.counts.totalLessons });
      return;
    }
    void doSynthesize(force);
  }

  const inFlight = status.latestRun?.status === "QUEUED" || status.latestRun?.status === "RUNNING";
  const coverage = data?.playbook?.frameworkCoverage ?? null;

  function downloadPlaybookJson() {
    if (!data?.playbook) return;
    const blob = new Blob([JSON.stringify(data.playbook, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "course-playbook.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPlaybookMarkdown() {
    if (!data?.playbook) return;
    const md = [`# ${data.playbook.title}`, ...data.playbook.sections.map((s) => `\n## ${s.title}\n\n${s.content}`)].join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "course-playbook.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="course-section course-intelligence">
      <div className="course-header">
        <h2>Course Intelligence</h2>
        <div className="course-actions">
          {status.canSynthesizeNow && !inFlight && (
            <button onClick={() => handleSynthesizeClick(false)} disabled={busy}>
              {status.latestCompletedRun ? (status.isOutOfDate ? "Synthesize Course (out of date)" : "Synthesize Course") : `Synthesize ${status.counts.analyzed} analyzed lesson(s)`}
            </button>
          )}
          {status.latestCompletedRun && !inFlight && (
            <button className="link-button" onClick={() => handleSynthesizeClick(true)} disabled={busy}>
              Re-synthesize
            </button>
          )}
        </div>
      </div>

      {!status.canSynthesizeNow && <p className="hint">No lessons have finished analysis yet — nothing to synthesize.</p>}

      {confirmDialog && (
        <div className="batch-confirm" role="alertdialog">
          <p>
            <strong>{confirmDialog.analyzed}</strong> of <strong>{confirmDialog.total}</strong> lessons have completed analysis.
            <br />
            <strong>{confirmDialog.remaining}</strong> are still queued/processing.
          </p>
          <p>Synthesize available analyses now? The result will be marked out of date once the remaining lessons finish.</p>
          <div className="batch-confirm-actions">
            <button onClick={() => void doSynthesize(confirmDialog.force)}>Synthesize Current Results</button>
            <button className="link-button" onClick={() => setConfirmDialog(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {inFlight && (
        <p className="hint">
          Synthesizing course{status.latestRun?.currentStage ? ` — ${status.latestRun.currentStage.replace(/_/g, " ")}` : "…"}. This can take several
          minutes; feel free to navigate away and come back.
        </p>
      )}
      {status.latestRun?.status === "FAILED" && (
        <div className="error-box">Last synthesis attempt failed: {status.latestRun.sanitizedError ?? "Unknown error."}</div>
      )}
      {errorMessage && <div className="error-box">{errorMessage}</div>}

      {coverage && (
        <div className={`batch-confirm coverage-banner coverage-${coverage.status.toLowerCase()}`} role="status">
          <p>
            <strong>Canonical Strategy Coverage:</strong> <span>{status.isOutOfDate ? "Out of date" : "Current"}</span>
            <br />
            <strong>Course-Wide Framework Coverage:</strong> <span>{coverage.status === "COMPLETE" ? "Complete" : "Partial"}</span>
          </p>
          <p>{coverage.coverageNote}</p>
        </div>
      )}

      {data && (
        <>
          <div className="course-toolbar ci-tabs">
            {TABS.map((tab) => (
              <button key={tab} className={tab === activeTab ? "" : "link-button"} onClick={() => setActiveTab(tab)}>
                {tab}
              </button>
            ))}
          </div>

          <div className="ci-tab-content">
            {activeTab === "Overview" && (
              <div className="dashboard-tiles">
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{data.clusters.reduce((sum, c) => sum + c.cluster.memberInstanceIds.length, 0)}</div>
                  <div className="dashboard-tile-label">Strategies Discovered</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{data.canonicalStrategies.length}</div>
                  <div className="dashboard-tile-label">Canonical Strategies</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{new Set(data.canonicalStrategies.flatMap((c) => c.strategy.sourceLessonIds)).size}</div>
                  <div className="dashboard-tile-label">Lessons Contributing</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{data.coreFramework?.sections.reduce((sum, s) => sum + s.rules.length, 0) ?? 0}</div>
                  <div className="dashboard-tile-label">Course-Wide Rules</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">
                    {(data.playbook?.conflictsAndAmbiguities.length ?? 0) + data.canonicalStrategies.reduce((sum, c) => sum + c.strategy.conflicts.length, 0)}
                  </div>
                  <div className="dashboard-tile-label">Conflicts Detected</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{formatCost(data.run.estimatedCost)}</div>
                  <div className="dashboard-tile-label">Synthesis Cost</div>
                </div>
                <div className="dashboard-tile">
                  <div className="dashboard-tile-value">{data.run.completedAt ? new Date(data.run.completedAt).toLocaleDateString() : "—"}</div>
                  <div className="dashboard-tile-label">Last Synthesized</div>
                </div>
              </div>
            )}

            {activeTab === "Canonical Strategies" && (
              <div>
                {data.canonicalStrategies.length === 0 ? (
                  <p className="hint">No canonical strategies were synthesized (no standalone setups were found among analyzed lessons).</p>
                ) : (
                  data.canonicalStrategies.map((info) => <CanonicalStrategyCard key={info.canonicalStrategyId} info={info} />)
                )}
              </div>
            )}

            {activeTab === "Core Framework" && (
              <div>
                {(data.coreFramework?.sections.length ?? 0) === 0 ? (
                  <p className="hint">No cross-strategy principles were identified.</p>
                ) : (
                  data.coreFramework!.sections.map((section) => (
                    <div className="rule-section" key={section.key}>
                      <h4>{section.title}</h4>
                      <RuleList rules={section.rules} />
                    </div>
                  ))
                )}
              </div>
            )}

            {activeTab === "Playbook" && data.playbook && (
              <div className="result-panel">
                <div className="detail-actions">
                  <h3 style={{ margin: 0 }}>{data.playbook.title}</h3>
                  <button className="link-button" onClick={downloadPlaybookJson}>
                    Download JSON
                  </button>
                  <button className="link-button" onClick={downloadPlaybookMarkdown}>
                    Download Markdown
                  </button>
                </div>
                {data.playbook.sections.map((section) => (
                  <div className="rule-section" key={section.key}>
                    <h4>{section.title}</h4>
                    <p className="drawer-summary" style={{ whiteSpace: "pre-wrap" }}>
                      {section.content}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "Decision Framework" && (
              <div>
                <p className="hint">Structured JSON is also available for a future flowchart view; shown here as a step-by-step walkthrough.</p>
                <ol className="plain-list">
                  {(data.decisionFramework?.readableSteps ?? []).map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
            )}

            {activeTab === "Conflicts" && (
              <div>
                <div className="rule-section">
                  <h4>Course-Wide Conflicts &amp; Ambiguities</h4>
                  {(data.playbook?.conflictsAndAmbiguities.length ?? 0) === 0 ? (
                    <p className="hint">None surfaced at the course-wide level.</p>
                  ) : (
                    <ul className="plain-list">
                      {data.playbook!.conflictsAndAmbiguities.map((c, i) => (
                        <li key={i} title={sourceTitle(c.sources)}>
                          {c.description}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {data.canonicalStrategies
                  .filter((c) => c.strategy.conflicts.length > 0 || c.strategy.variants.length > 0)
                  .map((c) => (
                    <div className="rule-section" key={c.canonicalStrategyId}>
                      <h4>{c.strategy.name}</h4>
                      {c.strategy.conflicts.length > 0 && (
                        <ul className="plain-list">
                          {c.strategy.conflicts.map((conflict, i) => (
                            <li key={i} title={sourceTitle(conflict.sources)}>
                              ⚠ {conflict.description}
                            </li>
                          ))}
                        </ul>
                      )}
                      {c.strategy.variants.length > 0 && (
                        <ul className="plain-list">
                          {c.strategy.variants.map((v, i) => (
                            <li key={i}>Variant: {v.description}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
              </div>
            )}

            {activeTab === "Sources" && (
              <div className="rule-section">
                <h4>Source Index</h4>
                <pre className="json-block">{data.playbook?.sections.find((s) => s.key === "source_index")?.content ?? "—"}</pre>
                <h4>Coverage Notes</h4>
                <pre className="json-block">{data.playbook?.sections.find((s) => s.key === "coverage_notes")?.content ?? "—"}</pre>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
