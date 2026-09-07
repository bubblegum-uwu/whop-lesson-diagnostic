import { ProjectHeader } from "./ProjectHeader";
import { DashboardSummary } from "../components/DashboardSummary";
import { CourseTable, type CourseTableProps } from "../components/CourseTable";
import { FindWhopUserId, type FindWhopUserIdState } from "../components/FindWhopUserId";
import { ConfigForm } from "../components/ConfigForm";
import { DiagnosticResult } from "../components/DiagnosticResult";
import { ErrorResult } from "../components/ErrorResult";
import { AnalyzeLesson } from "../components/AnalyzeLesson";
import type { AnalysisSummary } from "../lib/courseApi";
import type { DiagnosticDisplayPayload } from "../lib/diagnosticPayload";
import type { LessonFetchOutcome } from "../lib/whopApi";

/**
 * The single-lesson diagnostic flow's state (paste one Whop lesson URL,
 * sign in, inspect its raw media info) — unrelated to the course/synthesis
 * flow, but an existing working tool this phase must not lose. Mirrors
 * App.tsx's AppState exactly; relocated here unchanged.
 */
export type DiagnosticFlowState =
  | { phase: "config"; errorMessage: string | null; submitting: boolean }
  | { phase: "exchanging" }
  | { phase: "fetching" }
  | { phase: "result"; payload: DiagnosticDisplayPayload; lessonUrl: string; accessToken: string }
  | { phase: "api_error"; outcome: Exclude<LessonFetchOutcome, { kind: "success" }> }
  | { phase: "fatal_error"; message: string };

export interface SourcesPageProps {
  courseTitle: string | null;
  lessons: CourseTableProps["lessons"];
  connected: boolean;
  syncing: boolean;
  authRequired: boolean;
  lastSyncedAt: string | null;
  summary: AnalysisSummary | null;
  courseErrorMessage: string | null;
  onSignIn: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  onEnqueue: (lessonIds: number[], force?: boolean) => void;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  onLoadAnalysis: (lessonId: number) => Promise<unknown | null>;

  identifyState: FindWhopUserIdState;
  onFindUserId: () => void;

  backendUrl: string | null;
  diagnosticState: DiagnosticFlowState;
  redirectUri: string;
  onDiagnosticSubmit: (lessonUrl: string) => void;
  onDiagnosticReset: () => void;
}

/**
 * Phase 4A — "/projects/:projectId/sources". Provider cards (Whop
 * operational, YouTube/Discord "Coming Soon") plus the existing Whop
 * sign-in/sync/lesson-analysis UI and the two standalone Whop utility
 * tools (single-lesson diagnostic, find-my-user-id), all reusing the
 * SAME components/handlers App.tsx already wires up — no analysis
 * behavior changed, only where it's rendered.
 */
export function SourcesPage(props: SourcesPageProps) {
  return (
    <div className="knovera-page">
      <ProjectHeader />

      <h2 className="knovera-section-title">Source Providers</h2>
      <div className="knovera-provider-grid">
        <div className="knovera-provider-card operational">
          <div className="knovera-provider-card-top">
            <h3>Whop</h3>
            <span className="knovera-badge-operational">Operational</span>
          </div>
          <p className="knovera-provider-desc">
            {props.courseTitle ?? "The Trading Accelerator"} — course lessons, synced and analyzed via Whop.
          </p>
        </div>
        <div className="knovera-provider-card">
          <div className="knovera-provider-card-top">
            <h3>YouTube</h3>
            <span className="knovera-badge-soon">Coming Soon</span>
          </div>
          <p className="knovera-provider-desc">Analyze a list of YouTube video URLs.</p>
        </div>
        <div className="knovera-provider-card">
          <div className="knovera-provider-card-top">
            <h3>Discord</h3>
            <span className="knovera-badge-soon">Coming Soon</span>
          </div>
          <p className="knovera-provider-desc">Analyze video shared in Discord posts/channels.</p>
        </div>
      </div>

      {props.backendUrl && (
        <>
          <DashboardSummary summary={props.summary} />
          <CourseTable
            courseTitle={props.courseTitle}
            lessons={props.lessons}
            connected={props.connected}
            syncing={props.syncing}
            authRequired={props.authRequired}
            lastSyncedAt={props.lastSyncedAt}
            summary={props.summary}
            onSignIn={props.onSignIn}
            onSync={props.onSync}
            onDisconnect={props.onDisconnect}
            onEnqueue={props.onEnqueue}
            onRetry={props.onRetry}
            onCancel={props.onCancel}
            onLoadAnalysis={props.onLoadAnalysis}
          />
        </>
      )}
      {props.courseErrorMessage && <div className="error-box">{props.courseErrorMessage}</div>}

      <details className="knovera-diagnostic-tools">
        <summary>Diagnostic Tools</summary>
        <FindWhopUserId state={props.identifyState} onStart={props.onFindUserId} />

        {props.diagnosticState.phase === "config" && (
          <ConfigForm
            redirectUri={props.redirectUri}
            onSubmit={props.onDiagnosticSubmit}
            submitting={props.diagnosticState.submitting}
            errorMessage={props.diagnosticState.errorMessage}
          />
        )}
        {props.diagnosticState.phase === "exchanging" && <p className="status-line">Exchanging authorization code for tokens…</p>}
        {props.diagnosticState.phase === "fetching" && <p className="status-line">Fetching lesson from Whop…</p>}
        {props.diagnosticState.phase === "result" && (
          <>
            <DiagnosticResult payload={props.diagnosticState.payload} />
            {props.backendUrl && (
              <AnalyzeLesson backendUrl={props.backendUrl} lessonUrl={props.diagnosticState.lessonUrl} accessToken={props.diagnosticState.accessToken} />
            )}
            <button onClick={props.onDiagnosticReset}>Start over</button>
          </>
        )}
        {props.diagnosticState.phase === "api_error" && (
          <>
            <ErrorResult outcome={props.diagnosticState.outcome} />
            <button onClick={props.onDiagnosticReset}>Start over</button>
          </>
        )}
        {props.diagnosticState.phase === "fatal_error" && (
          <>
            <div className="error-panel" role="alert">
              <h2>ERROR</h2>
              <p>{props.diagnosticState.message}</p>
            </div>
            <button onClick={props.onDiagnosticReset}>Start over</button>
          </>
        )}
      </details>
    </div>
  );
}
