import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PROJECTS, PROJECT_TYPE_LABEL, OPERATIONAL_PROJECT_TYPES } from "../lib/projects";
import { NewProjectDialog } from "./NewProjectDialog";

/**
 * Phase 4A — "/projects". Reads from the frontend-only PROJECTS list
 * (lib/projects.ts) — no new backend endpoint. Real persistence, live
 * source/synthesis counts, and last-synthesized dates are Phase 4B+.
 */
export function ProjectsPage() {
  const navigate = useNavigate();
  const [showNewProject, setShowNewProject] = useState(false);

  return (
    <div className="knovera-page">
      <div className="knovera-page-header">
        <h1>Projects</h1>
        <button type="button" className="knovera-cta-secondary" onClick={() => setShowNewProject(true)}>
          + New Project
        </button>
      </div>

      <div className="knovera-project-grid">
        {PROJECTS.map((project) => {
          const operational = OPERATIONAL_PROJECT_TYPES.has(project.type);
          return (
            <div key={project.id} className="knovera-project-card">
              <div className="knovera-project-card-top">
                <h2>{project.name}</h2>
                <span className="knovera-badge-type">{PROJECT_TYPE_LABEL[project.type]}</span>
              </div>
              {!operational && <span className="knovera-badge-soon">Coming Soon</span>}
              <button
                type="button"
                className="knovera-cta-secondary"
                disabled={!operational}
                onClick={() => navigate(`/projects/${project.id}/sources`)}
              >
                Open Project
              </button>
            </div>
          );
        })}
      </div>

      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
    </div>
  );
}
