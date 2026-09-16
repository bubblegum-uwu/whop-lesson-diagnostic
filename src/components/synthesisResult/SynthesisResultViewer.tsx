/**
 * Phase 4M follow-up — the human-readable Run History result viewer. Reuses
 * the same presentation components CourseIntelligence's synthesis viewer
 * uses (CoreFrameworkView/PlaybookView/DecisionFrameworkView/SourcesView/
 * CanonicalStrategyCard) so a completed Run's output — LEGACY_WHOP or
 * NATIVE alike — renders exactly as readably as the live project synthesis
 * view, instead of a raw JSON dump. Playbook is the default/primary tab
 * (not Overview) — see the task's own framing of the Playbook as "the
 * primary human-readable result" for a Run.
 *
 * `rawOutput` is exactly what GET .../runs/:runId/output returned as
 * `result` (untyped on the wire — see synthesisSetRunsApi.ts) — this
 * component is the one place that normalizes it, defensively, via
 * normalizeRunResult, and is the only place Raw JSON is ever shown
 * (behind an explicit, collapsed-by-default "Advanced" toggle).
 */
import { useState } from "react";
import type { SynthesisSetRunSummary } from "../../lib/synthesisSetRunsApi";
import { normalizeRunResult } from "./types";
import { CanonicalStrategyCard } from "./CanonicalStrategyCard";
import { CoreFrameworkView } from "./CoreFrameworkView";
import { PlaybookView } from "./PlaybookView";
import { DecisionFrameworkView } from "./DecisionFrameworkView";
import { SourcesView } from "./SourcesView";
import { downloadJsonFile, formatCost, formatDurationSeconds } from "./format";

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const BASE_TABS = ["Overview", "Core Framework", "Playbook", "Decision Framework", "Sources"] as const;
type BaseTab = (typeof BASE_TABS)[number];
type Tab = BaseTab | "Canonical Strategies";

export function SynthesisResultViewer({ run, rawOutput, filenameBase }: { run: SynthesisSetRunSummary; rawOutput: unknown; filenameBase: string }) {
  const result = normalizeRunResult(rawOutput);
  const hasClusters = run.kind === "NATIVE" && result.clusters != null;
  const tabs: Tab[] = hasClusters ? [...BASE_TABS, "Canonical Strategies"] : [...BASE_TABS];

  const [activeTab, setActiveTab] = useState<Tab>("Playbook");
  const [showRaw, setShowRaw] = useState(false);

  const coreFrameworkRuleCount = result.coreFramework?.sections?.reduce((sum, s) => sum + s.rules.length, 0) ?? null;
  const conflictCount = result.playbook?.conflictsAndAmbiguities?.length ?? null;

  return (
    <div className="result-panel">
      <div className="ci-tabs">
        {tabs.map((tab) => (
          <button key={tab} type="button" className={tab === activeTab ? "ci-tab active" : "ci-tab"} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      <div className="ci-tab-content">
        {activeTab === "Overview" && (
          <div className="dashboard-tiles">
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{run.readyCount}</div>
              <div className="dashboard-tile-label">Inputs</div>
            </div>
            {hasClusters && (
              <div className="dashboard-tile">
                <div className="dashboard-tile-value">{result.clusters!.length}</div>
                <div className="dashboard-tile-label">Canonical Strategies</div>
              </div>
            )}
            {coreFrameworkRuleCount != null && (
              <div className="dashboard-tile">
                <div className="dashboard-tile-value">{coreFrameworkRuleCount}</div>
                <div className="dashboard-tile-label">Course-Wide Rules</div>
              </div>
            )}
            {conflictCount != null && (
              <div className="dashboard-tile">
                <div className="dashboard-tile-value">{conflictCount}</div>
                <div className="dashboard-tile-label">Conflicts Detected</div>
              </div>
            )}
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{formatCost(run.estimatedCost)}</div>
              <div className="dashboard-tile-label">Synthesis Cost</div>
            </div>
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{formatDurationSeconds(run.processingDurationSeconds)}</div>
              <div className="dashboard-tile-label">Duration</div>
            </div>
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{formatDateTime(run.completedAt)}</div>
              <div className="dashboard-tile-label">Completed</div>
            </div>
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{run.model ?? "—"}</div>
              <div className="dashboard-tile-label">Model</div>
            </div>
            <div className="dashboard-tile">
              <div className="dashboard-tile-value">{run.promptVersion ?? "—"}</div>
              <div className="dashboard-tile-label">Prompt Version</div>
            </div>
          </div>
        )}

        {activeTab === "Core Framework" && <CoreFrameworkView coreFramework={result.coreFramework} />}

        {activeTab === "Playbook" && <PlaybookView playbook={result.playbook} filenameBase={filenameBase} />}

        {activeTab === "Decision Framework" && <DecisionFrameworkView decisionFramework={result.decisionFramework} />}

        {activeTab === "Sources" && <SourcesView playbook={result.playbook} />}

        {activeTab === "Canonical Strategies" && hasClusters && (
          <div>
            {result.clusters!.map((c, i) => (
              <CanonicalStrategyCard key={i} strategy={c.canonicalStrategy} />
            ))}
          </div>
        )}
      </div>

      <div className="knovera-synthesis-set-detail-actions">
        <button type="button" className="link-button" onClick={() => downloadJsonFile(rawOutput, `${filenameBase}.json`)}>
          Download Full Run JSON
        </button>
        <button type="button" className="link-button" onClick={() => setShowRaw((v) => !v)}>
          {showRaw ? "Hide Raw JSON" : "View Raw JSON"}
        </button>
      </div>
      {showRaw && (
        <div className="kv-card">
          <h4 className="knovera-section-title">Advanced — Raw JSON</h4>
          <pre className="json-block">{JSON.stringify(rawOutput, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
