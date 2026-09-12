import { useEffect, useState } from "react";
import { listProjects, type ProjectSummary } from "../lib/projectsApi";
import { PROJECT_TYPE_LABEL, type ProjectType } from "../lib/projects";
import { addProjectSourceToProjects, AddToProjectError, type AddToProjectResultEntry } from "../lib/addToProjectApi";

export interface AddToProjectDialogProps {
  backendUrl: string;
  knoveraToken: string;
  /** The project this source is currently in (e.g. Discord Knowledge) — excluded from the picker list, and never itself removed by this dialog: this is copy/reference, not move. */
  projectId: number;
  sourceId: number;
  sourceTitle: string;
  onClose: () => void;
}

type LoadState = { phase: "loading" } | { phase: "loaded"; projects: ProjectSummary[] } | { phase: "error"; message: string };
type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string } | { phase: "done"; results: AddToProjectResultEntry[] };

const RESULT_LABELS: Record<AddToProjectResultEntry["kind"], string> = {
  added: "Added",
  already_present: "Already added",
  unauthorized: "Not authorized",
  invalid: "Unavailable",
};

/**
 * Phase 4K-B (revised) — "Add to Project…". Makes an already-captured
 * Discord source available in other projects, of ANY project type,
 * without copying media or re-analyzing (see
 * backend/src/http/routes/projectSources.ts's
 * createAddProjectSourceToProjectsHandler). The source always remains in
 * its current project — there is no "move" option, deliberately.
 */
export function AddToProjectDialog({ backendUrl, knoveraToken, projectId, sourceId, sourceTitle, onClose }: AddToProjectDialogProps) {
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
      const { results } = await addProjectSourceToProjects(backendUrl, knoveraToken, projectId, sourceId, [...selected]);
      setSubmitState({ phase: "done", results });
    } catch (err) {
      setSubmitState({ phase: "error", message: err instanceof AddToProjectError ? err.message : "Failed to add to project. Please try again." });
    }
  }

  function resultFor(id: number): AddToProjectResultEntry | undefined {
    return submitState.phase === "done" ? submitState.results.find((r) => r.projectId === id) : undefined;
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="add-to-project-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-to-project-title">Add to Project…</h2>
        <p className="knovera-dialog-subtitle">
          Make &quot;{sourceTitle}&quot; available in other projects. It stays exactly where it is now — this never removes or moves it.
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
                      {result && <span className={`kv-badge ${result.kind === "added" ? "kv-badge-accent" : "kv-badge-muted"}`}>{RESULT_LABELS[result.kind]}</span>}
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
