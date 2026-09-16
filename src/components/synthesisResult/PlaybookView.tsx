/**
 * Phase 4M follow-up — extracted from CourseIntelligence.tsx's Playbook tab.
 * This is the primary human-readable synthesis result for both
 * CourseIntelligence and Run History: title, section headings, preserved
 * paragraph formatting, Download JSON, Download Markdown. `filenameBase`
 * lets each caller pick its own deterministic filename without duplicating
 * the download wiring. Tolerant of a playbook with no `sections` (a
 * recovered legacy playbook row is not guaranteed to carry one) — never
 * crashes, never fabricates sections.
 */
import type { CoursePlaybook } from "../../lib/synthesisApi";
import { downloadJsonFile, downloadTextFile, playbookToMarkdown } from "./format";

export function PlaybookView({ playbook, filenameBase }: { playbook: CoursePlaybook | null; filenameBase: string }) {
  if (!playbook) return <p className="hint">No playbook is available for this run.</p>;
  const sections = playbook.sections ?? [];
  return (
    <div className="result-panel">
      <div className="detail-actions">
        <h3 style={{ margin: 0 }}>{playbook.title}</h3>
        <button className="link-button" onClick={() => downloadJsonFile(playbook, `${filenameBase}.json`)}>
          Download JSON
        </button>
        <button className="link-button" onClick={() => downloadTextFile(playbookToMarkdown(playbook), `${filenameBase}.md`, "text/markdown")}>
          Download Markdown
        </button>
      </div>
      {sections.length === 0 ? (
        <p className="hint">No playbook sections available.</p>
      ) : (
        sections.map((section) => (
          <div className="rule-section" key={section.key}>
            <h4>{section.title}</h4>
            <p className="drawer-summary" style={{ whiteSpace: "pre-wrap" }}>
              {section.content}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
