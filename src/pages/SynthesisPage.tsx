import { ProjectHeader } from "./ProjectHeader";
import { CourseIntelligence, type CourseIntelligenceProps } from "../components/CourseIntelligence";

/**
 * Phase 4A — "/projects/:projectId/synthesis". Pure relocation: renders the
 * existing, unmodified CourseIntelligence component (Phase 3.5B's full
 * production synthesis UI — Overview/Canonical Strategies/Core Framework/
 * Playbook/Decision Framework/Conflicts/Sources tabs, progress, cost, JSON
 * download) under the new project-workspace header. No synthesis API,
 * prompt, clustering, scope, or audit behavior touched.
 */
export function SynthesisPage(props: CourseIntelligenceProps) {
  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={props.backendUrl} knoveraToken={props.knoveraToken} />
      {props.backendUrl && <CourseIntelligence {...props} />}
    </div>
  );
}
