/**
 * Phase 4M follow-up — extracted from CourseIntelligence.tsx's
 * CanonicalStrategyCard, with its prop narrowed from the legacy-only
 * `CanonicalStrategyInfo` wrapper to the bare `CanonicalStrategy` shared by
 * both the legacy course-synthesis engine and the native Phase 4M engine
 * (backend/src/synthesis/runSynthesis.ts's `ClusterWithStrategy.
 * canonicalStrategy` is the exact same type) — so this one component
 * renders a canonical strategy identically in CourseIntelligence's
 * "Canonical Strategies" tab and Run History's "Clusters" tab. Rendering
 * body unchanged.
 */
import { useState } from "react";
import type { CanonicalStrategy } from "../../lib/synthesisApi";
import { RuleList } from "./RuleList";
import { sourceTitle } from "./format";

export function CanonicalStrategyCard({ strategy: s }: { strategy: CanonicalStrategy }) {
  const [expanded, setExpanded] = useState(false);
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
