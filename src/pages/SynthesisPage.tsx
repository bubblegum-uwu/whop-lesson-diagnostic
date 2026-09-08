import { ProjectHeader } from "./ProjectHeader";
import { CourseIntelligence, type CourseIntelligenceProps } from "../components/CourseIntelligence";
import { useResolvedProject } from "../lib/useResolvedProject";

export type SynthesisPageProps = Omit<CourseIntelligenceProps, "projectId">;

/**
 * Phase 4A — "/projects/:projectId/synthesis". Renders CourseIntelligence
 * (Phase 3.5B's full production synthesis UI — Overview/Canonical
 * Strategies/Core Framework/Playbook/Decision Framework/Conflicts/Sources
 * tabs, progress, cost, JSON download) under the project-workspace header.
 * No synthesis API, prompt, clustering, scope, or audit behavior touched.
 *
 * Phase 4E — resolves the route's :projectId to the real numeric project id
 * via useResolvedProject (the same resolution ProjectHeader/SourcesPage
 * already use, including the legacy "mastermind" slug) and passes it to
 * CourseIntelligence, which is what makes synthesis project-aware: the
 * route/project now determines the synthesis input, never a globally
 * configured course.
 */
export function SynthesisPage(props: SynthesisPageProps) {
  const { state } = useResolvedProject(props.backendUrl, props.knoveraToken);
  const projectId = state.phase === "resolved" ? state.project.id : null;

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={props.backendUrl} knoveraToken={props.knoveraToken} />
      {props.backendUrl && <CourseIntelligence {...props} projectId={projectId} />}
    </div>
  );
}
