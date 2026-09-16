/**
 * Phase 4M follow-up — extracted verbatim from CourseIntelligence.tsx.
 * `coreFramework` is nullable here because a LEGACY_WHOP or NATIVE Run's
 * output can, in principle, carry no core framework — never fabricated.
 */
import type { CoreFramework } from "../../lib/synthesisApi";
import { RuleList } from "./RuleList";

export function CoreFrameworkView({ coreFramework }: { coreFramework: CoreFramework | null }) {
  const sections = coreFramework?.sections ?? [];
  if (sections.length === 0) return <p className="hint">No cross-strategy principles were identified.</p>;
  return (
    <div>
      {sections.map((section) => (
        <div className="rule-section" key={section.key}>
          <h4>{section.title}</h4>
          <RuleList rules={section.rules} />
        </div>
      ))}
    </div>
  );
}
