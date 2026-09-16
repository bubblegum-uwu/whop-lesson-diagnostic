/**
 * Phase 4M follow-up — extracted verbatim from CourseIntelligence.tsx so
 * CourseIntelligence and the Run History result viewer render rules
 * identically. Never renders a rule as raw JSON.
 */
import type { SynthesizedRule } from "../../lib/synthesisApi";
import { sourceTitle } from "./format";

export function RuleList({ rules }: { rules: SynthesizedRule[] }) {
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
