import { useEffect, useState } from "react";
import { listProjects, type ProjectSummary } from "../lib/projectsApi";
import { PROJECT_TYPE_LABEL, type ProjectType } from "../lib/projects";
import { addCollectionToProject, CatalogApiError, type AddCollectionToProjectTargetResult } from "../lib/catalogApi";

export interface AddCollectionToProjectDialogProps {
  backendUrl: string;
  knoveraToken: string;
  /** The project this collection/group currently belongs to — excluded from the picker list, and never itself changed by this dialog: this is copy/reference, not move. */
  projectId: number;
  /** The collection's opaque groupKey (a persisted collection's numeric id as a string, or a "derived:..." key) — passed through verbatim, never parsed. */
  groupKey: string;
  collectionLabel: string;
  onClose: () => void;
}

type LoadState = { phase: "loading" } | { phase: "loaded"; projects: ProjectSummary[] } | { phase: "error"; message: string };
type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string } | { phase: "done"; memberCount: number; results: AddCollectionToProjectTargetResult[] };

function resultSummary(result: AddCollectionToProjectTargetResult): string {
  if (result.kind === "invalid") return "Unavailable";
  const parts: string[] = [];
  if (result.addedCount > 0) parts.push(`${result.addedCount} added`);
  if (result.alreadyPresentCount > 0) parts.push(`${result.alreadyPresentCount} already there`);
  if (result.failedCount > 0) parts.push(`${result.failedCount} failed`);
  return parts.length > 0 ? parts.join(" · ") : "Nothing to add";
}

/**
 * Phase 4L follow-up — "Add Collection to Project…". Copies a collection's
 * CURRENT members into other projects, preserving provenance so the SAME
 * canonical group (persisted or derived) resolves in the destination (see
 * backend/src/http/routes/sourceCollections.ts's
 * createAddCollectionToProjectHandler doc comment). A ONE-TIME snapshot,
 * never a live sync — this dialog can be reopened later to add anything
 * newly missing. The source collection always stays exactly where it is;
 * there is no "move" option.
 */
export function AddCollectionToProjectDialog({ backendUrl, knoveraToken, projectId, groupKey, collectionLabel, onClose }: AddCollectionToProjectDialogProps) {
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitState, setSubmitState] = useState<SubmitState>({ phase: "idle" });
  const submitting = submitState.phase === "submitting";

  useEffect(() => {
    let cancelled = false;
    listProjects(backendUrl, knoveraToken)
      .then((projects) => {
        if (!cancelled) setLoadState({ phase: "loaded", projects: projects.filter((p) => p.id !== projectId) });
      })
      .catch((err) => {
        if (!cancelled) setLoadState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load projects." });
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl, knoveraToken, projectId]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (submitting || selected.size === 0) return;
    setSubmitState({ phase: "submitting" });
    try {
      const { memberCount, results } = await addCollectionToProject(backendUrl, knoveraToken, projectId, groupKey, [...selected]);
      setSubmitState({ phase: "done", memberCount, results });
    } catch (err) {
      setSubmitState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to add to project. Please try again." });
    }
  }

  function resultFor(id: number): AddCollectionToProjectTargetResult | undefined {
    return submitState.phase === "done" ? submitState.results.find((r) => r.targetProjectId === id) : undefined;
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="add-collection-to-project-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-collection-to-project-title">Add Collection to Project…</h2>
        <p className="knovera-dialog-subtitle">
          Copy &quot;{collectionLabel}&quot;&rsquo;s current members into other projects. This is a one-time snapshot — it stays exactly where it is now, and a
          source added here later won&rsquo;t automatically appear elsewhere; run this again to add anything newly missing.
        </p>

        {loadState.phase === "loading" && <p className="hint">Loading projects…</p>}
        {loadState.phase === "error" && (
          <p className="knovera-field-error" role="alert">
            {loadState.message}
          </p>
        )}

        {loadState.phase === "loaded" && (
          <>
            {loadState.projects.length === 0 ? (
              <p className="hint">There are no other projects to add this to yet.</p>
            ) : (
              <ul className="knovera-add-to-project-list">
                {loadState.projects.map((project) => {
                  const result = resultFor(project.id);
                  return (
                    <li key={project.id}>
                      <label className="knovera-synthesis-set-source-checkbox">
                        <input
                          type="checkbox"
                          checked={selected.has(project.id)}
                          onChange={() => toggle(project.id)}
                          disabled={submitting || submitState.phase === "done"}
                        />
                        <span>
                          {project.name} <span className="hint">({PROJECT_TYPE_LABEL[project.projectType as ProjectType]})</span>
                        </span>
                      </label>
                      {result && <span className={`kv-badge ${result.kind === "ok" && result.addedCount > 0 ? "kv-badge-accent" : "kv-badge-muted"}`}>{resultSummary(result)}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {submitState.phase === "error" && (
          <p className="knovera-field-error" role="alert">
            {submitState.message}
          </p>
        )}

        <div className="knovera-dialog-actions">
          <button type="button" className="link-button" onClick={onClose} disabled={submitting}>
            {submitState.phase === "done" ? "Close" : "Cancel"}
          </button>
          {submitState.phase !== "done" && (
            <button type="button" disabled={submitting || selected.size === 0 || loadState.phase !== "loaded"} onClick={() => void handleSubmit()}>
              {submitting ? "Adding…" : `Add to ${selected.size || ""} Project${selected.size === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
