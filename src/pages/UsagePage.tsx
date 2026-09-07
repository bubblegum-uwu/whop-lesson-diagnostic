function currentMonthLabel(): string {
  return new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * "/usage". UI shell only, per spec: no monthly-spend query exists yet
 * (that's Phase 4E, which will sum lesson_analyses.estimated_cost +
 * synthesis_runs.estimated_cost for the current month — see the Phase 4
 * investigation report). Deliberately shows no dollar figures at all here,
 * real or otherwise, rather than a fabricated $0.00 that could be
 * mistaken for a real total. Phase 4B: no longer reads the retired
 * frontend-only PROJECTS list — usage-per-project is Phase 4E's job once a
 * real spend query exists; until then this is a single static row.
 */
export function UsagePage() {
  return (
    <div className="knovera-page">
      <div>
        <h1 className="knovera-page-title">Usage &amp; Spend</h1>
        <p className="knovera-usage-month">{currentMonthLabel()}</p>
      </div>

      <div className="kv-card knovera-usage-table">
        <div className="knovera-usage-row">
          <span className="knovera-usage-project">MasterMind</span>
          <span className="knovera-usage-pending">Current-month spend calculation coming in Phase 4E</span>
        </div>
      </div>
    </div>
  );
}
