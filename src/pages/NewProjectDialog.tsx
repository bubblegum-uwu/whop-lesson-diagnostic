import { useState } from "react";
import { ProjectType, PROJECT_TYPE_LABEL, OPERATIONAL_PROJECT_TYPES } from "../lib/projects";

/**
 * Phase 4A — "+ New Project" is UI-only: project persistence is Phase 4B.
 * Picking a type never pretends a project was created; it just reveals the
 * honest "coming in the next platform phase" message. GENERAL_KNOWLEDGE is
 * selectable (per spec: "architecturally selectable") but always shows
 * Coming Soon — no General Knowledge synthesis engine exists.
 */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<ProjectType | null>(null);

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="knovera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="new-project-title">New Project</h2>
        <p className="knovera-dialog-subtitle">Choose a project type.</p>

        <div className="knovera-type-options">
          {(Object.values(ProjectType) as ProjectType[]).map((type) => {
            const operational = OPERATIONAL_PROJECT_TYPES.has(type);
            return (
              <button
                key={type}
                type="button"
                className={selected === type ? "knovera-type-option selected" : "knovera-type-option"}
                onClick={() => setSelected(type)}
              >
                <span className="knovera-type-option-name">{PROJECT_TYPE_LABEL[type]}</span>
                {!operational && <span className="knovera-badge-soon">Coming Soon</span>}
              </button>
            );
          })}
        </div>

        {selected && (
          <p className="knovera-dialog-notice">Project creation will be enabled in the next platform phase.</p>
        )}

        <div className="knovera-dialog-actions">
          <button type="button" className="link-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
