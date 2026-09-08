import { useEffect, useState } from "react";
import { ProjectHeader } from "./ProjectHeader";
import { WhopIcon, YouTubeIcon, DiscordIcon } from "../components/ProviderIcons";
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
import { useResolvedProject } from "../lib/useResolvedProject";
import { getProjectSources, type ProjectSource } from "../lib/sourcesApi";

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
  accessToken: string | null;
  diagnosticState: DiagnosticFlowState;
  redirectUri: string;
  onDiagnosticSubmit: (lessonUrl: string) => void;
  onDiagnosticReset: () => void;
}

type SourcesLoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; sources: ProjectSource[] }
  | { phase: "error"; message: string };

/**
 * Phase 4A — "/projects/:projectId/sources". Provider cards (Whop
 * operational, YouTube/Discord "Coming Soon") plus the existing Whop
 * sign-in/sync/lesson-analysis UI and the two standalone Whop utility
 * tools (single-lesson diagnostic, find-my-user-id), all reusing the
 * SAME components/handlers App.tsx already wires up — no analysis
 * behavior changed, only where it's rendered.
 *
 * Phase 4C — additionally loads this project's real connected sources from
 * `GET /api/projects/:projectId/sources` (via the same `useResolvedProject`
 * hook ProjectHeader uses) to: (1) show the Whop provider card's real
 * connection state instead of always assuming a course is connected, and
 * (2) keep the legacy course table/mutation UI below from ever rendering
 * for a project that doesn't actually own a Whop course — see the "no
 * sources confirmed" branch. The legacy `courseState` props (still globally
 * scoped to the one configured Whop course, via App.tsx) are otherwise
 * untouched: this only decides WHETHER to show them for the current
 * project, never what they contain.
 */
export function SourcesPage(props: SourcesPageProps) {
  const { state: projectState } = useResolvedProject(props.backendUrl, props.accessToken);
  const [sourcesState, setSourcesState] = useState<SourcesLoadState>({ phase: "idle" });

  async function loadSources(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setSourcesState({ phase: "loading" });
    try {
      const result = await getProjectSources(url, token, projectId);
      if (!cancelledRef.current) setSourcesState({ phase: "loaded", sources: result.sources });
    } catch (err) {
      if (!cancelledRef.current) {
        setSourcesState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load sources." });
      }
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.accessToken) {
      setSourcesState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void loadSources(props.backendUrl, props.accessToken, projectState.project.id, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, props.backendUrl, props.accessToken]);

  const whopSource = sourcesState.phase === "loaded" ? sourcesState.sources.find((s) => s.provider === "WHOP") : undefined;
  // Only a completed, successful lookup that found zero Whop sources counts
  // as "confirmed empty" — idle (signed out / not yet resolved), loading,
  // and error all fall back to the pre-Phase-4C behavior below (which
  // includes CourseTable's own "Connect Whop" prompt — the app's primary
  // sign-in entry point — so those states must never hide it).
  const confirmedNoWhopSource = sourcesState.phase === "loaded" && !whopSource;

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={props.backendUrl} accessToken={props.accessToken} />

      <h2 className="knovera-section-title">Source Providers</h2>
      <div className="knovera-provider-grid">
        <div className={confirmedNoWhopSource ? "kv-card knovera-provider-card" : "kv-card knovera-provider-card operational"}>
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <WhopIcon className="knovera-provider-icon" />
              <h3>Whop</h3>
            </div>
            {confirmedNoWhopSource ? (
              <span className="kv-badge kv-badge-muted">Not Connected</span>
            ) : whopSource ? (
              <span className="kv-badge kv-badge-accent">Connected</span>
            ) : (
              <span className="kv-badge kv-badge-accent">Operational</span>
            )}
          </div>
          <p className="knovera-provider-desc">
            {confirmedNoWhopSource
              ? "No Whop course connected to this project yet."
              : whopSource
                ? `${whopSource.name} — course lessons, synced and analyzed via Whop.`
                : `${props.courseTitle ?? "The Trading Accelerator"} — course lessons, synced and analyzed via Whop.`}
          </p>
        </div>
        <div className="kv-card knovera-provider-card">
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <YouTubeIcon className="knovera-provider-icon" />
              <h3>YouTube</h3>
            </div>
            <span className="kv-badge kv-badge-muted">Coming Soon</span>
          </div>
          <p className="knovera-provider-desc">Analyze a list of YouTube video URLs.</p>
        </div>
        <div className="kv-card knovera-provider-card">
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <DiscordIcon className="knovera-provider-icon" />
              <h3>Discord</h3>
            </div>
            <span className="kv-badge kv-badge-muted">Coming Soon</span>
          </div>
          <p className="knovera-provider-desc">Analyze video shared in Discord posts/channels.</p>
        </div>
      </div>

      {sourcesState.phase === "loading" && <p className="knovera-sources-loading">Loading sources…</p>}

      {sourcesState.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{sourcesState.message}</p>
        </div>
      )}

      {confirmedNoWhopSource && (
        <div className="kv-card knovera-empty-state">
          <p>No sources connected yet.</p>
          <p>Connect Whop, YouTube, or Discord above to bring content into this project.</p>
        </div>
      )}

      {props.backendUrl && !confirmedNoWhopSource && (
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
