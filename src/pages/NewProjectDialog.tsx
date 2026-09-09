import { useState, type FormEvent } from "react";
import { ProjectType, PROJECT_TYPE_LABEL } from "../lib/projects";
import { createProject, CreateProjectError, type ProjectSummary } from "../lib/projectsApi";

/** Phase 4G — shown under each selectable project type, per the exact copy in the acceptance spec. Never implies a synthesis engine exists for General Knowledge; only project creation itself is available now. */
const PROJECT_TYPE_DESCRIPTION: Record<ProjectType, string> = {
  TRADING_STRATEGIES: "Analyze and synthesize trading education and strategies.",
  GENERAL_KNOWLEDGE: "Create the project now. General Knowledge synthesis is coming soon.",
};

export interface NewProjectDialogProps {
  backendUrl: string;
  /** The Knovera session token (Phase 4D) — never a Whop token. */
  knoveraToken: string;
  onClose: () => void;
  /** Called once the project is really created, with the real project returned by POST /api/projects — the caller navigates to its Sources page. */
  onCreated: (project: ProjectSummary) => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4G — the "+ New Project" dialog is now real: it calls
 * POST /api/projects and hands the created project back to the caller.
 * Still create-only (see the Phase 4G PR description) — no rename/delete/
 * archive, no source attachment, nothing beyond the one INSERT the backend
 * performs. Cancel (including the backdrop) never calls the API at all, so
 * it is guaranteed to create nothing.
 */
export function NewProjectDialog({ backendUrl, knoveraToken, onClose, onCreated }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<ProjectType | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [state, setState] = useState<SubmitState>({ phase: "idle" });

  const trimmedName = name.trim();
  const nameError = nameTouched && trimmedName.length === 0 ? "Project name is required." : null;
  const submitting = state.phase === "submitting";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setNameTouched(true);
    if (submitting) return; // belt-and-braces against a double Enter/click race; the disabled button below is the primary guard.
    if (trimmedName.length === 0 || !selected) return;

    setState({ phase: "submitting" });
    try {
      const project = await createProject(backendUrl, knoveraToken, trimmedName, selected);
      onCreated(project);
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof CreateProjectError ? err.message : "Failed to create project. Please try again.",
      });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div
        className="knovera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="new-project-title">New Project</h2>
        <p className="knovera-dialog-subtitle">Name your project and choose a type.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="new-project-name">Project Name</label>
          <input
            id="new-project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            disabled={submitting}
            autoFocus
            autoComplete="off"
          />
          {nameError && (
            <p className="knovera-field-error" role="alert">
              {nameError}
            </p>
          )}

          <div className="knovera-type-options" role="radiogroup" aria-label="Project Type">
            {(Object.values(ProjectType) as ProjectType[]).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={selected === type}
                className={selected === type ? "knovera-type-option selected" : "knovera-type-option"}
                onClick={() => setSelected(type)}
                disabled={submitting}
              >
                <span className="knovera-type-option-text">
                  <span className="knovera-type-option-name">{PROJECT_TYPE_LABEL[type]}</span>
                  <span className="knovera-type-option-desc">{PROJECT_TYPE_DESCRIPTION[type]}</span>
                </span>
              </button>
            ))}
          </div>

          {state.phase === "error" && (
            <p className="knovera-dialog-notice" role="alert">
              {state.message}
            </p>
          )}

          <div className="knovera-dialog-actions">
            <button type="button" className="link-button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || trimmedName.length === 0 || !selected}>
              {submitting ? "Creating…" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
