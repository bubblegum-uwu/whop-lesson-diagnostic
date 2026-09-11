import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { NewSynthesisSetDialog } from "./NewSynthesisSetDialog";
import { useResolvedProject } from "../lib/useResolvedProject";
import { listSynthesisSets, deleteSynthesisSet, type SynthesisSetSummary } from "../lib/synthesisSetsApi";

export interface SynthesisSetsPageProps {
  backendUrl: string | null;
  /** The Knovera session token — never a Whop token. Synthesis Sets are a project-level configuration concept, independent of whether Whop is connected. */
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; sets: SynthesisSetSummary[] }
  | { phase: "error"; message: string };

/** Readiness is always shown as "N selected · N analyzed · N needs analysis" — never a single collapsed number, so an unanalyzed member is never silently implied to "not count" (Phase 4J spec section 14/23). */
function readinessSummary(set: SynthesisSetSummary): string {
  return `${set.sourceCount} selected · ${set.analyzedSourceCount} analyzed · ${set.needsAnalysisCount} needs analysis`;
}

/**
 * "/projects/:projectId/synthesis-sets" — Phase 4J. Lists every persistent
 * Synthesis Set this project owns (a configuration only — see
 * synthesisSetsApi.ts's doc comment): create new ones, delete existing
 * ones, and open a set to manage its member sources. This is entirely
 * separate from "/projects/:projectId/synthesis" (the frozen Phase 3.5B
 * Whop-only synthesis EXECUTION UI, untouched by this phase) — creating or
 * editing a set here never runs any synthesis.
 */
export function SynthesisSetsPage({ backendUrl, knoveraToken }: SynthesisSetsPageProps) {
  const navigate = useNavigate();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [showNewSet, setShowNewSet] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const sets = await listSynthesisSets(url, token, projectId);
      if (!cancelledRef.current) setState({ phase: "loaded", sets });
    } catch (err) {
      if (!cancelledRef.current) {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load synthesis sets." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) {
      void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
    }
  }

  async function handleDelete(setId: number) {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setDeletingId(setId);
    try {
      await deleteSynthesisSet(backendUrl, knoveraToken, resolvedProjectId, setId);
      setPendingDeleteId(null);
      refresh();
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to delete synthesis set." });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      <div className="knovera-page-header">
        <h2 className="knovera-section-title">Synthesis Sets</h2>
      </div>
      <p className="knovera-dialog-subtitle">
        Group sources into named sets to synthesize together. Adding a source here never analyzes it — analysis stays a separate step on the Sources
        page.
      </p>

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading synthesis sets…</p>}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {(state.phase === "loaded" || state.phase === "idle" || state.phase === "loading") && (
        <div className="knovera-project-grid">
          {state.phase === "loaded" && state.sets.length === 0 && (
            <div className="kv-card knovera-empty-state">
              <p>No synthesis sets yet.</p>
              <p>Create one to start grouping sources for synthesis.</p>
            </div>
          )}

          {state.phase === "loaded" &&
            state.sets.map((set) => (
              <div key={set.id} className="kv-card knovera-project-card operational">
                <div className="knovera-project-card-top">
                  <div>
                    <h2>{set.name}</h2>
                    <p className="knovera-project-card-source">{set.description || "No description"}</p>
                  </div>
                </div>

                <div className="knovera-project-card-stats">
                  <div className="knovera-project-card-stat">
                    <span className="knovera-project-card-stat-value">{set.sourceCount}</span>
                    <span className="knovera-project-card-stat-label">Selected</span>
                  </div>
                  <div className="knovera-project-card-stat">
                    <span className="knovera-project-card-stat-value">{set.analyzedSourceCount}</span>
                    <span className="knovera-project-card-stat-label">Analyzed</span>
                  </div>
                  <div className="knovera-project-card-stat">
                    <span className="knovera-project-card-stat-value">{set.needsAnalysisCount}</span>
                    <span className="knovera-project-card-stat-label">Needs Analysis</span>
                  </div>
                </div>
                <p className="hint" aria-label="Readiness summary">
                  {readinessSummary(set)}
                </p>

                {pendingDeleteId === set.id ? (
                  <div className="knovera-project-card-footer knovera-synthesis-set-confirm-delete">
                    <span className="hint">Delete this set?</span>
                    <button type="button" className="link-button" onClick={() => setPendingDeleteId(null)} disabled={deletingId === set.id}>
                      Cancel
                    </button>
                    <button type="button" className="link-button danger" onClick={() => void handleDelete(set.id)} disabled={deletingId === set.id}>
                      {deletingId === set.id ? "Deleting…" : "Confirm Delete"}
                    </button>
                  </div>
                ) : (
                  <div className="knovera-project-card-footer">
                    <button type="button" className="link-button" onClick={() => setPendingDeleteId(set.id)}>
                      Delete
                    </button>
                    <button type="button" className="knovera-open-link" onClick={() => navigate(`/projects/${resolvedProjectId}/synthesis-sets/${set.id}`)}>
                      Open
                      <span className="knovera-cta-arrow" aria-hidden="true">
                        →
                      </span>
                    </button>
                  </div>
                )}
              </div>
            ))}

          <div className="kv-card knovera-project-card secondary">
            <button type="button" className="knovera-new-project-button" onClick={() => setShowNewSet(true)} disabled={resolvedProjectId == null}>
              <span className="knovera-new-project-plus" aria-hidden="true">
                +
              </span>
              New Synthesis Set
            </button>
          </div>
        </div>
      )}

      {showNewSet && backendUrl && knoveraToken && resolvedProjectId != null && (
        <NewSynthesisSetDialog
          backendUrl={backendUrl}
          knoveraToken={knoveraToken}
          projectId={resolvedProjectId}
          onClose={() => setShowNewSet(false)}
          onCreated={(set) => {
            setShowNewSet(false);
            navigate(`/projects/${resolvedProjectId}/synthesis-sets/${set.id}`);
          }}
        />
      )}
    </div>
  );
}
