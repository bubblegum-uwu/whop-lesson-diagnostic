import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PROJECT_TYPE_LABEL, OPERATIONAL_PROJECT_TYPES, MASTERMIND_ROUTE_SLUG, type ProjectType } from "../lib/projects";
import { listProjects, type ProjectSummary } from "../lib/projectsApi";
import { NewProjectDialog } from "./NewProjectDialog";

export interface ProjectsPageProps {
  backendUrl: string | null;
  /** In-memory Whop access token from App.tsx's OAuth state — null until the operator signs in (see App.tsx). GET /api/projects requires it, same as every other course/analysis route. */
  accessToken: string | null;
}

type LoadState =
  | { phase: "signed_out" }
  | { phase: "loading" }
  | { phase: "loaded"; projects: ProjectSummary[] }
  | { phase: "error"; message: string };

/**
 * Phase 4B — "/projects". Reads the real `GET /api/projects` list (no more
 * hardcoded PROJECTS array). Requires the operator's Whop access token, same
 * as every other protected route in this app; while signed out, the page
 * shows a sign-in prompt rather than fetching or fabricating data.
 */
export function ProjectsPage({ backendUrl, accessToken }: ProjectsPageProps) {
  const navigate = useNavigate();
  const [showNewProject, setShowNewProject] = useState(false);
  const [state, setState] = useState<LoadState>({ phase: "signed_out" });

  async function load(url: string, token: string, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const projects = await listProjects(url, token);
      if (!cancelledRef.current) setState({ phase: "loaded", projects });
    } catch (err) {
      if (!cancelledRef.current) {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load projects." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !accessToken) {
      setState({ phase: "signed_out" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, accessToken, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, accessToken]);

  return (
    <div className="knovera-page">
      <div className="knovera-page-header">
        <h1 className="knovera-page-title">Projects</h1>
      </div>

      {state.phase === "signed_out" && (
        <div className="kv-card knovera-empty-state">
          <p>Sign in with Whop to view your projects.</p>
          <button type="button" className="link-button" onClick={() => navigate(`/projects/${MASTERMIND_ROUTE_SLUG}/sources`)}>
            Go to Sources →
          </button>
        </div>
      )}

      {state.phase === "loading" && (
        <div className="kv-card knovera-empty-state">
          <p>Loading projects…</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {(state.phase === "loaded" || state.phase === "signed_out" || state.phase === "loading") && (
        <div className="knovera-project-grid">
          {state.phase === "loaded" &&
            state.projects.length === 0 && (
              <div className="kv-card knovera-empty-state">
                <p>No projects yet.</p>
              </div>
            )}

          {state.phase === "loaded" &&
            state.projects.map((project) => {
              const projectType = project.projectType as ProjectType;
              const operational = OPERATIONAL_PROJECT_TYPES.has(projectType);
              const showStats = operational && project.lessonCount > 0;
              return (
                <div key={project.id} className={operational ? "kv-card knovera-project-card operational" : "kv-card knovera-project-card"}>
                  <div className="knovera-project-card-top">
                    <div>
                      <h2>{project.name}</h2>
                      <p className="knovera-project-card-source">Whop</p>
                    </div>
                    {operational ? (
                      <span className="kv-badge kv-badge-accent">{PROJECT_TYPE_LABEL[projectType]}</span>
                    ) : (
                      <span className="kv-badge kv-badge-muted">Coming Soon</span>
                    )}
                  </div>

                  {showStats && (
                    <div className="knovera-project-card-stats">
                      <div className="knovera-project-card-stat">
                        <span className="knovera-project-card-stat-value">{project.lessonCount}</span>
                        <span className="knovera-project-card-stat-label">Lessons</span>
                      </div>
                      {project.latestSynthesisStatus && (
                        <div className="knovera-project-card-stat">
                          <span className="knovera-project-card-stat-value">{project.latestSynthesisStatus}</span>
                          <span className="knovera-project-card-stat-label">Last Synthesis</span>
                        </div>
                      )}
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
      )}

      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
    </div>
  );
}
