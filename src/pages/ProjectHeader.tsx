import { Navigate, NavLink, useParams } from "react-router-dom";
import { findProject, PROJECT_TYPE_LABEL } from "../lib/projects";

/**
 * Phase 4A — shared header for both the Sources and Synthesis project
 * pages: "← Projects", the project's name/type, and the Sources/Synthesis
 * tab nav. An unknown :projectId (only "mastermind" exists today) bounces
 * back to the Projects list rather than rendering a broken page. Visual-
 * polish pass: Sources/Synthesis render as a segmented-tab control (see
 * .knovera-segmented-tabs in index.css) instead of plain link text.
 */
export function ProjectHeader() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = findProject(projectId);

  if (!project) return <Navigate to="/projects" replace />;

  return (
    <div className="knovera-project-header">
      <NavLink to="/projects" className="knovera-back-link">
        ← Projects
      </NavLink>
      <div className="knovera-project-title-row">
        <h1>{project.name}</h1>
        <span className="kv-badge kv-badge-muted knovera-project-type">{PROJECT_TYPE_LABEL[project.type]}</span>
      </div>
      <nav className="knovera-segmented-tabs" aria-label="Project workspace">
        <NavLink to={`/projects/${project.id}/sources`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Sources
        </NavLink>
        <NavLink to={`/projects/${project.id}/synthesis`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Synthesis
        </NavLink>
      </nav>
    </div>
  );
}
