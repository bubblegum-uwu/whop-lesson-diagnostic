import { Navigate, NavLink } from "react-router-dom";
import { PROJECT_TYPE_LABEL, MASTERMIND_ROUTE_SLUG, ProjectType } from "../lib/projects";
import { useResolvedProject } from "../lib/useResolvedProject";

export interface ProjectHeaderProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

/** A route param that could never resolve to any project — not the legacy slug, not even a syntactically valid (non-negative integer) database id. Used to redirect immediately on garbage without waiting on a network round trip; a real numeric id always waits for the lookup below instead (see the hotfix note on the redirect condition). */
function isPlausibleProjectRouteParam(routeParam: string | undefined): boolean {
  if (!routeParam) return false;
  return routeParam === MASTERMIND_ROUTE_SLUG || /^\d+$/.test(routeParam);
}

/**
 * Shared header for both the Sources and Synthesis project pages: "←
 * Projects", the project's name/type, and the Sources/Synthesis tab nav.
 *
 * Resolves the route against the real `GET /api/projects` list (via
 * `useResolvedProject`, shared with SourcesPage's own source lookup)
 * instead of a hardcoded lookup. That call requires the Knovera session
 * token (never Whop, since Phase 4D — see lib/useResolvedProject.ts), so
 * while signed out — or before the fetch resolves — this falls back to the
 * known legacy "mastermind" slug's real name/type rather than showing
 * nothing; it only redirects to /projects once a completed fetch
 * definitively finds no matching project, or the route param could never
 * be valid at all.
 */
export function ProjectHeader({ backendUrl, knoveraToken }: ProjectHeaderProps) {
  const { state, routeParam } = useResolvedProject(backendUrl, knoveraToken);

  const isLegacySlug = routeParam === MASTERMIND_ROUTE_SLUG;

  // HOTFIX: a syntactically valid numeric project id (e.g. /projects/1/sources
  // from the real GET /api/projects id) must NOT bounce back to /projects
  // just because the async lookup above is still idle/in flight — only a
  // definitive "not_found" from a completed fetch, or a route param that
  // could never be valid in the first place, redirects. The previous
  // version redirected on ANY non-legacy-slug param on the very first
  // (pre-fetch) render, which is what caused Open → Projects loop.
  if (state.phase === "not_found" || !isPlausibleProjectRouteParam(routeParam)) {
    return <Navigate to="/projects" replace />;
  }

  const showLegacyFallback = state.phase !== "resolved" && isLegacySlug;
  const name = state.phase === "resolved" ? state.project.name : showLegacyFallback ? "MasterMind" : "Loading…";
  const projectType: ProjectType | null =
    state.phase === "resolved" ? (state.project.projectType as ProjectType) : showLegacyFallback ? ProjectType.TRADING_STRATEGIES : null;
  const linkId = state.phase === "resolved" ? String(state.project.id) : showLegacyFallback ? MASTERMIND_ROUTE_SLUG : (routeParam as string);

  return (
    <div className="knovera-project-header">
      <NavLink to="/projects" className="knovera-back-link">
        ← Projects
      </NavLink>
      <div className="knovera-project-title-row">
        <h1>{name}</h1>
        {projectType && <span className="kv-badge kv-badge-muted knovera-project-type">{PROJECT_TYPE_LABEL[projectType]}</span>}
      </div>
      <nav className="knovera-segmented-tabs" aria-label="Project workspace">
        <NavLink to={`/projects/${linkId}/sources`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Sources
        </NavLink>
        <NavLink to={`/projects/${linkId}/synthesis`} className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}>
          Synthesis
        </NavLink>
        {/* Phase 4J — a distinct tab from "Synthesis" above on purpose: that
            tab is the frozen Phase 3.5B Whop-only synthesis EXECUTION UI,
            while this one is the new persistent source-grouping
            CONFIGURATION UI (Synthesis Set != Synthesis Run — see the
            synthesisSetsApi.ts doc comment). isActive matches this tab for
            both the list and detail routes since both start with this
            prefix. */}
        <NavLink
          to={`/projects/${linkId}/synthesis-sets`}
          className={({ isActive }) => (isActive ? "knovera-project-tab active" : "knovera-project-tab")}
        >
          Synthesis Sets
        </NavLink>
      </nav>
    </div>
  );
}
