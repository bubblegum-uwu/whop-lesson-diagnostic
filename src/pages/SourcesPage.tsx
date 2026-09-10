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
import { AddYouTubeVideoDialog } from "../components/AddYouTubeVideoDialog";
import type { AnalysisSummary } from "../lib/courseApi";
import type { DiagnosticDisplayPayload } from "../lib/diagnosticPayload";
import type { LessonFetchOutcome } from "../lib/whopApi";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getProjectSources, type ProjectSource, type WhopProjectSource, type YouTubeProjectSource } from "../lib/sourcesApi";

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
  /** LIVE Whop provider-connection state (GET /api/auth/status) — distinct from whether this project has ever had a persisted source, see sourcesState below. Drives the provider card's Connected/Not Connected badge. */
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
  /** The Knovera session token (Phase 4D) — never a Whop token. Everything on this page except the standalone diagnostic tool below (which keeps its own separately-obtained Whop token, see diagnosticState) reads/writes using this. */
  knoveraToken: string | null;
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
 * "/projects/:projectId/sources". Provider cards (Whop operational,
 * YouTube/Discord "Coming Soon") plus the existing Whop sync/lesson-analysis
 * UI and the two standalone Whop utility tools (single-lesson diagnostic,
 * find-my-user-id), all reusing the SAME components/handlers App.tsx
 * already wires up — no analysis behavior changed, only where it's
 * rendered.
 *
 * Loads this project's real connected sources from `GET
 * /api/projects/:projectId/sources` (via the same `useResolvedProject` hook
 * ProjectHeader uses) to keep the legacy course table/mutation UI below
 * from ever rendering for a project that has never owned a Whop course —
 * see `confirmedNeverHadSource` below.
 *
 * Phase 4D — critically, that "has a source ever been persisted" signal is
 * kept SEPARATE from `props.connected` (the LIVE Whop provider-connection
 * state, from GET /api/auth/status): a course row and its lessons/analyses
 * persist in Postgres independent of whether Whop is currently connected,
 * so disconnecting Whop must never hide MasterMind's existing lessons —
 * only flip the provider card to "Not Connected" and offer Connect Whop.
 */
export function SourcesPage(props: SourcesPageProps) {
  const { state: projectState } = useResolvedProject(props.backendUrl, props.knoveraToken);
  const [sourcesState, setSourcesState] = useState<SourcesLoadState>({ phase: "idle" });
  const [showAddYouTubeDialog, setShowAddYouTubeDialog] = useState(false);

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
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      setSourcesState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void loadSources(props.backendUrl, props.knoveraToken, projectState.project.id, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, props.backendUrl, props.knoveraToken]);

  const whopSource: WhopProjectSource | undefined =
    sourcesState.phase === "loaded" ? sourcesState.sources.find((s): s is WhopProjectSource => s.provider === "WHOP") : undefined;
  // Phase 4H-A — this project's persisted YouTube sources, independent of
  // whopSource above: a project can have YouTube sources with zero Whop
  // courses, and vice versa (see the Phase 4H-A PR description's project
  // isolation rules).
  const youtubeSources: YouTubeProjectSource[] =
    sourcesState.phase === "loaded" ? sourcesState.sources.filter((s): s is YouTubeProjectSource => s.provider === "YOUTUBE") : [];
  // Only a completed, successful lookup that found zero Whop sources counts
  // as "confirmed never had a Whop source" — idle (signed out / not yet
  // resolved), loading, and error all fall back to the pre-Phase-4C
  // behavior below (which includes CourseTable's own "Connect Whop"
  // prompt), so those states must never hide it. This is independent of
  // live Whop connection — see the component doc comment above. Gates the
  // Whop-specific CourseTable/DashboardSummary block and Diagnostic Tools
  // below — both are Whop utilities, unaffected by whether this project
  // also has YouTube sources.
  const confirmedNeverHadWhopSource = sourcesState.phase === "loaded" && !whopSource;
  // The top empty-state box, by contrast, is about this project having NO
  // source at all — a project with YouTube sources but no Whop course must
  // never show "No sources connected yet."
  const confirmedNeverHadAnySource = confirmedNeverHadWhopSource && youtubeSources.length === 0;
  const whopLiveConnected = props.connected;
  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;

  function refreshSources() {
    if (props.backendUrl && props.knoveraToken && resolvedProjectId != null) {
      void loadSources(props.backendUrl, props.knoveraToken, resolvedProjectId, { current: false });
    }
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={props.backendUrl} knoveraToken={props.knoveraToken} />

      <h2 className="knovera-section-title">Source Providers</h2>
      <div className="knovera-provider-grid">
        <div className={whopLiveConnected ? "kv-card knovera-provider-card operational" : "kv-card knovera-provider-card"}>
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <WhopIcon className="knovera-provider-icon" />
              <h3>Whop</h3>
            </div>
            {whopLiveConnected ? (
              <span className="kv-badge kv-badge-accent">Connected</span>
            ) : (
              <span className="kv-badge kv-badge-muted">Not Connected</span>
            )}
          </div>
          <p className="knovera-provider-desc">
            {whopSource
              ? `${whopSource.name} — course lessons, synced and analyzed via Whop.`
              : sourcesState.phase !== "loaded" && whopLiveConnected
                ? `${props.courseTitle ?? "The Trading Accelerator"} — course lessons, synced and analyzed via Whop.`
                : "Connect a Whop course to sync and analyze its lessons."}
          </p>
          {!whopLiveConnected && (
            <button type="button" className="knovera-provider-connect-button" onClick={props.onSignIn}>
              Connect Whop
            </button>
          )}
        </div>
        <div className="kv-card knovera-provider-card">
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <YouTubeIcon className="knovera-provider-icon" />
              <h3>YouTube</h3>
            </div>
          </div>
          <p className="knovera-provider-desc">Add public YouTube videos to this project.</p>
          <button
            type="button"
            className="knovera-provider-connect-button"
            onClick={() => setShowAddYouTubeDialog(true)}
            disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
          >
            Add YouTube Video
          </button>
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

      {confirmedNeverHadAnySource && (
        <div className="kv-card knovera-empty-state">
          <p>No sources connected yet.</p>
          <p>Connect Whop or add a YouTube video to add content. Discord support is coming soon.</p>
        </div>
      )}

      {youtubeSources.length > 0 && (
        <>
          <h2 className="knovera-section-title">YouTube Sources</h2>
          <ul className="knovera-youtube-source-list">
            {youtubeSources.map((source) => (
              <li key={source.id} className="kv-card knovera-youtube-source-row">
                <div className="knovera-youtube-source-main">
                  <span className="knovera-youtube-source-label">YouTube Video</span>
                  <span className="knovera-youtube-source-title">{source.title ?? source.sourceUrl}</span>
                </div>
                <span className="kv-badge kv-badge-muted">Added</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {props.backendUrl && !confirmedNeverHadWhopSource && (
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

      {/* Phase 4C correction: these are Whop-specific utilities (single-lesson
          diagnostic, find-my-user-id) — legacy implementation UI that has no
          purpose on a project confirmed to have no Whop course. Hidden only
          on that definitive signal, same as CourseTable above, so it never
          disappears mid-load or pre-auth (where it's still the way to sign
          in) — and never hidden for MasterMind, which does have a source.
          Phase 4H-A: this gate stays Whop-specific (confirmedNeverHadWhopSource,
          not confirmedNeverHadAnySource) — a project with only YouTube
          sources still has no Whop course to run these Whop utilities
          against. */}
      {!confirmedNeverHadWhopSource && (
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
      )}

      {showAddYouTubeDialog && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <AddYouTubeVideoDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          onClose={() => setShowAddYouTubeDialog(false)}
          onAdded={() => {
            setShowAddYouTubeDialog(false);
            refreshSources();
          }}
        />
      )}
    </div>
  );
}
