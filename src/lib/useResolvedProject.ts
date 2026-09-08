import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { resolveProjectRoute } from "./projects";
import { listProjects, type ProjectSummary } from "./projectsApi";

export type ResolvedProjectState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "resolved"; project: ProjectSummary }
  | { phase: "not_found" };

/**
 * Resolves the current route's `:projectId` param against the real `GET
 * /api/projects` list. Shared by `ProjectHeader` and `SourcesPage` (each
 * renders under the same matched route, so each gets its own `useParams()`
 * — this is the exact resolution logic the Phase 4B navigation hotfix
 * fixed, extracted unchanged so both call sites stay in sync; see
 * ProjectHeader's redirect logic for why `"idle"`/`"loading"` must never be
 * treated as `"not_found"`.
 */
export function useResolvedProject(backendUrl: string | null, knoveraToken: string | null): { state: ResolvedProjectState; routeParam: string | undefined } {
  const { projectId: routeParam } = useParams<{ projectId: string }>();
  const [state, setState] = useState<ResolvedProjectState>({ phase: "idle" });

  async function resolve(url: string, token: string, param: string | undefined, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const projects = await listProjects(url, token);
      if (cancelledRef.current) return;
      const resolved = resolveProjectRoute(projects, param);
      setState(resolved ? { phase: "resolved", project: resolved } : { phase: "not_found" });
    } catch {
      if (!cancelledRef.current) setState({ phase: "idle" });
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void resolve(backendUrl, knoveraToken, routeParam, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, routeParam]);

  return { state, routeParam };
}
