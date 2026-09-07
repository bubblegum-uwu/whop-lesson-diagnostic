import { PROJECTS } from "../lib/projects";

function currentMonthLabel(): string {
  return new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Phase 4A — "/usage". UI shell only, per spec: no monthly-spend query
 * exists yet (that's Phase 4E, which will sum lesson_analyses.estimated_cost
 * + synthesis_runs.estimated_cost for the current month — see the Phase 4
 * investigation report). Deliberately shows no dollar figures at all here,
 * real or otherwise, rather than a fabricated $0.00 that could be
 * mistaken for a real total.
 */
export function UsagePage() {
  return (
    <div className="knovera-page">
      <h1>Usage &amp; Spend</h1>
      <p className="knovera-usage-month">{currentMonthLabel()}</p>

      <div className="knovera-usage-table">
        {PROJECTS.map((project) => (
          <div key={project.id} className="knovera-usage-row">
            <span className="knovera-usage-project">{project.name}</span>
            <span className="knovera-usage-pending">Current-month spend calculation coming in Phase 4E</span>
          </div>
        ))}
      </div>
    </div>
  );
}
