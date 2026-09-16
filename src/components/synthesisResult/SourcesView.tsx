/**
 * Phase 4M follow-up — extracted verbatim (behavior-wise) from
 * CourseIntelligence.tsx's Sources tab. Reads the two deterministic
 * playbook sections a run's synthesis always writes when it has a
 * playbook; tolerant of no playbook / no matching section.
 */
import type { CoursePlaybook } from "../../lib/synthesisApi";

export function SourcesView({ playbook }: { playbook: CoursePlaybook | null }) {
  const sections = playbook?.sections ?? [];
  const sourceIndex = sections.find((s) => s.key === "source_index")?.content ?? "—";
  const coverageNotes = sections.find((s) => s.key === "coverage_notes")?.content ?? "—";
  return (
    <div className="rule-section">
      <h4>Source Index</h4>
      <pre className="json-block">{sourceIndex}</pre>
      <h4>Coverage Notes</h4>
      <pre className="json-block">{coverageNotes}</pre>
    </div>
  );
}
