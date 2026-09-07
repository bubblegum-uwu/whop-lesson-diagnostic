import { useEffect, useState } from "react";
import { Navigate, NavLink, useParams } from "react-router-dom";
import { PROJECT_TYPE_LABEL, MASTERMIND_ROUTE_SLUG, resolveProjectRoute, ProjectType } from "../lib/projects";
import { listProjects, type ProjectSummary } from "../lib/projectsApi";

export interface ProjectHeaderProps {
  backendUrl: string | null;
  accessToken: string | null;
}

type ResolveState =
  | { phase: "unresolved" }
  | { phase: "resolved"; project: ProjectSummary }
  | { phase: "not_found" };

/**
 * Shared header for both the Sources and Synthesis project pages: "←
 * Projects", the project's name/type, and the Sources/Synthesis tab nav.
 *
 * Phase 4B: resolves the route against the real `GET /api/projects` list
 * instead of a hardcoded lookup. That call requires the operator's Whop
 * access token (same as every other course/analysis route), so while
 * signed out — or before the fetch resolves — this falls back to the
 * known legacy "mastermind" slug's real name/type rather than showing
 * nothing; it only redirects to /projects once a completed fetch
 * definitively finds no matching project for a non-legacy route param.
 */
export function ProjectHeader({ backendUrl, accessToken }: ProjectHeaderProps) {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const [state, setState] = useState<ResolveState>({ phase: "unresolved" });

  async function resolve(url: string, token: string, param: string | undefined, cancelledRef: { current: boolean }) {
    try {
      const projects = await listProjects(url, token);
      if (cancelledRef.current) return;
      const resolved = resolveProjectRoute(projects, param);
      setState(resolved ? { phase: "resolved", project: resolved } : { phase: "not_found" });
    } catch {
      if (!cancelledRef.current) setState({ phase: "unresolved" });
    }
  }

  useEffect(() => {
    if (!backendUrl || !accessToken) {
      setState({ phase: "unresolved" });
      return;
    }
    const cancelledRef = { current: false };
    void resolve(backendUrl, accessToken, routeParam, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, accessToken, routeParam]);

  if (state.phase === "not_found") return <Navigate to="/projects" replace />;

  const isLegacySlug = routeParam === MASTERMIND_ROUTE_SLUG;
  if (state.phase === "unresolved" && !isLegacySlug) return <Navigate to="/projects" replace />;

  const name = state.phase === "resolved" ? state.project.name : "MasterMind";
  const projectType = state.phase === "resolved" ? (state.project.projectType as ProjectType) : ProjectType.TRADING_STRATEGIES;
  const linkId = state.phase === "resolved" ? String(state.project.id) : MASTERMIND_ROUTE_SLUG;

  return (
    <div className="knovera-project-header">
      <NavLink to="/projects" className="knovera-back-link">
        ← Projects
      </NavLink>
      <div className="knovera-project-title-row">
        <h1>{name}</h1>
        <span className="kv-badge kv-badge-muted knovera-project-type">{PROJECT_TYPE_LABEL[projectType]}</span>
      </div>
      <nav className="knovera-segmented-tabs" aria-label="Project workspace">
        <NavLink to={`/projects/${linkId}/sources`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Sources
        </NavLink>
        <NavLink to={`/projects/${linkId}/synthesis`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Synthesis
        </NavLink>
      </nav>
    </div>
  );
}
