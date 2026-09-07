import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { PROJECTS, PROJECT_TYPE_LABEL, OPERATIONAL_PROJECT_TYPES } from "../lib/projects";
import { NewProjectDialog } from "./NewProjectDialog";

export interface ProjectsPageProps {
  /**
   * Live stats for the MasterMind card, threaded down from App.tsx's
   * existing courseState — never a new fetch, never fabricated. Omitted
   * (or connected: false) simply means the stats row doesn't render; the
   * card never shows a placeholder/fake number in its place.
   */
  connected?: boolean;
  lessonCount?: number;
}

/**
 * Phase 4A — "/projects". Reads from the frontend-only PROJECTS list
 * (lib/projects.ts) — no new backend endpoint. Real persistence, live
 * source/synthesis counts, and last-synthesized dates are Phase 4B+.
 */
export function ProjectsPage({ connected = false, lessonCount }: ProjectsPageProps) {
  const navigate = useNavigate();
  const [showNewProject, setShowNewProject] = useState(false);

  return (
    <div className="knovera-page">
      <div className="knovera-page-header">
        <h1 className="knovera-page-title">Projects</h1>
      </div>

      <div className="knovera-project-grid">
        {PROJECTS.map((project) => {
          const operational = OPERATIONAL_PROJECT_TYPES.has(project.type);
          const showStats = operational && connected && typeof lessonCount === "number";
          return (
            <div key={project.id} className={operational ? "kv-card knovera-project-card operational" : "kv-card knovera-project-card"}>
              <div className="knovera-project-card-top">
                <div>
                  <h2>{project.name}</h2>
                  <p className="knovera-project-card-source">Whop</p>
                </div>
                {operational ? (
                  <span className="kv-badge kv-badge-accent">{PROJECT_TYPE_LABEL[project.type]}</span>
                ) : (
                  <span className="kv-badge kv-badge-muted">Coming Soon</span>
                )}
              </div>

              {showStats && (
                <div className="knovera-project-card-stats">
                  <div className="knovera-project-card-stat">
                    <span className="knovera-project-card-stat-value">{lessonCount}</span>
                    <span className="knovera-project-card-stat-label">Lessons</span>
                  </div>
                </div>
              )}

              <div className="knovera-project-card-footer">
                <button
                  type="button"
                  className="knovera-open-link"
                  disabled={!operational}
                  onClick={() => navigate(`/projects/${project.id}/sources`)}
                >
                  Open
                  <span className="knovera-cta-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              </div>
            </div>
          );
        })}

        <div className="kv-card knovera-project-card secondary">
          <button type="button" className="knovera-new-project-button" onClick={() => setShowNewProject(true)}>
            <span className="knovera-new-project-plus" aria-hidden="true">
              +
            </span>
            New Project
          </button>
        </div>
      </div>

      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
    </div>
  );
}
