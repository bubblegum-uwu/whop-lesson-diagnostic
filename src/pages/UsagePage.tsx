import { useEffect, useState } from "react";
import { PROJECT_TYPE_LABEL, type ProjectType } from "../lib/projects";
import { getCurrentMonthUsage, type UsageResponse } from "../lib/usageApi";

export interface UsagePageProps {
  backendUrl: string | null;
  /** The Knovera session token (Phase 4D) — null until logged in. Never a Whop token: GET /api/usage works with no Whop connection at all. */
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "signed_out" }
  | { phase: "loading" }
  | { phase: "loaded"; usage: UsageResponse }
  | { phase: "error"; message: string };

function formatCost(value: number): string {
  return `$${value.toFixed(2)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * "/usage" — Phase 4F's real project-aware Usage & Spend dashboard: current
 * calendar month, analysis + synthesis cost per project, from GET
 * /api/usage (see db/usageRepo.ts for the exact accounting rule). Requires
 * only a Knovera session — never Whop; visible with Whop fully
 * disconnected, exactly like Projects/Sources/Synthesis.
 */
export function UsagePage({ backendUrl, knoveraToken }: UsagePageProps) {
  const [state, setState] = useState<LoadState>({ phase: "signed_out" });

  async function load(url: string, token: string, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const usage = await getCurrentMonthUsage(url, token);
      if (!cancelledRef.current) setState({ phase: "loaded", usage });
    } catch (err) {
      if (!cancelledRef.current) {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load usage." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken) {
      setState({ phase: "signed_out" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken]);

  return (
    <div className="knovera-page">
      <div className="knovera-page-header">
        <h1 className="knovera-page-title">Usage</h1>
        {state.phase === "loaded" && <p className="knovera-usage-month">{state.usage.period.label}</p>}
      </div>

      {state.phase === "signed_out" && (
        <div className="kv-card knovera-empty-state">
          <p>Sign in to view usage.</p>
        </div>
      )}

      {state.phase === "loading" && (
        <div className="kv-card knovera-empty-state">
          <p>Loading usage…</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {state.phase === "loaded" && (
        <>
          <div className="kv-card knovera-usage-total-card">
            <span className="knovera-usage-total-label">Total Spend</span>
            <span className="knovera-usage-total-value">{formatCost(state.usage.total.totalCost)}</span>
            <div className="knovera-usage-total-breakdown">
              <span>
                Analysis <strong>{formatCost(state.usage.total.analysisCost)}</strong>
              </span>
              <span>
                Synthesis <strong>{formatCost(state.usage.total.synthesisCost)}</strong>
              </span>
            </div>
          </div>

          {state.usage.total.totalCost === 0 && <p className="hint knovera-usage-zero-note">No usage recorded this month.</p>}

          <h2 className="knovera-section-title">Projects</h2>
          {state.usage.projects.length === 0 ? (
            <div className="kv-card knovera-empty-state">
              <p>No projects yet.</p>
            </div>
          ) : (
            <div className="knovera-usage-project-list">
              {state.usage.projects.map((project) => (
                <div key={project.projectId} className="kv-card knovera-usage-project-card">
                  <div className="knovera-usage-project-card-top">
                    <h3>{project.projectName}</h3>
                    <span className="kv-badge kv-badge-muted">{PROJECT_TYPE_LABEL[project.projectType as ProjectType]}</span>
                  </div>
                  <div className="knovera-usage-project-card-costs">
                    <span>
                      Analysis <strong>{formatCost(project.analysisCost)}</strong>
                    </span>
                    <span>
                      Synthesis <strong>{formatCost(project.synthesisCost)}</strong>
                    </span>
                    <span className="knovera-usage-project-card-total">
                      Total <strong>{formatCost(project.totalCost)}</strong>
                    </span>
                  </div>
                  {(project.lessonsAnalyzed > 0 || project.sourcesAnalyzed > 0 || project.synthesisRuns > 0) && (
                    <p className="knovera-usage-project-card-meta">
                      {[
                        project.lessonsAnalyzed > 0 ? `${plural(project.lessonsAnalyzed, "lesson")} analyzed` : null,
                        project.sourcesAnalyzed > 0 ? `${plural(project.sourcesAnalyzed, "video")} analyzed` : null,
                        `${plural(project.synthesisRuns, "synthesis run")}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
