/**
 * Phase 4M follow-up — extracted from CourseIntelligence.tsx's Decision
 * Framework tab, with one addition: an explicit empty/unavailable state
 * when there are no readable steps, so Run History never shows a blank
 * list for a Run whose output has no decision framework. Never exposes
 * raw decision-node JSON as the default view.
 */
import type { DecisionFramework } from "../../lib/synthesisApi";

export function DecisionFrameworkView({ decisionFramework }: { decisionFramework: DecisionFramework | null }) {
  const steps = decisionFramework?.readableSteps ?? [];
  if (steps.length === 0) return <p className="hint">No decision framework is available for this run.</p>;
  return (
    <div>
      <p className="hint">Structured JSON is also available for a future flowchart view; shown here as a step-by-step walkthrough.</p>
      <ol className="plain-list">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
