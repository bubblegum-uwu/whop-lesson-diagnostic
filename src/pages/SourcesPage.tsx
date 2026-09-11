import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { WhopIcon, YouTubeIcon, DiscordIcon } from "../components/ProviderIcons";
import { CourseTable, type CourseTableProps } from "../components/CourseTable";
import { FindWhopUserId, type FindWhopUserIdState } from "../components/FindWhopUserId";
import { ConfigForm } from "../components/ConfigForm";
import { DiagnosticResult } from "../components/DiagnosticResult";
import { ErrorResult } from "../components/ErrorResult";
import { AnalyzeLesson } from "../components/AnalyzeLesson";
import { AddYouTubeVideoDialog } from "../components/AddYouTubeVideoDialog";
import { AddDiscordVideoDialog } from "../components/AddDiscordVideoDialog";
import { BatchImportDialog } from "../components/BatchImportDialog";
import { AddYouTubeChannelDialog } from "../components/AddYouTubeChannelDialog";
import { ImportDiscordChannelsDialog } from "../components/ImportDiscordChannelsDialog";
import { ConnectWhopCourseDialog } from "../components/ConnectWhopCourseDialog";
import { ProjectSourceAnalysisDrawer } from "../components/ProjectSourceAnalysisDrawer";
import type { AnalysisSummary } from "../lib/courseApi";
import type { DiagnosticDisplayPayload } from "../lib/diagnosticPayload";
import type { LessonFetchOutcome } from "../lib/whopApi";
import { useResolvedProject } from "../lib/useResolvedProject";
import {
  getProjectSources,
  type ProjectSource,
  type WhopProjectSource,
  type YouTubeProjectSource,
  type DiscordProjectSource,
} from "../lib/sourcesApi";
import {
  analyzeProjectSource,
  getProjectSourceAnalysis,
  retryProjectSourceAnalysis,
  ProjectSourceAnalysisError,
  type ProjectSourceAnalysisStatus,
} from "../lib/projectSourceAnalysisApi";
import {
  listSourceCollections,
  listAlaCarteWhopLessons,
  listDiscordGuilds,
  startDiscordConnect,
  disconnectDiscordGuild,
  CatalogApiError,
  type CatalogCollectionSummary,
  type AlaCarteWhopLessonSummary,
  type DiscordGuildSummary,
} from "../lib/catalogApi";
import { enqueueAnalysisJobs } from "../lib/courseApi";

/** Phase 4H-B — display labels for the job-status badge on a video source row. Falls back to "Added" for any status this map doesn't recognize (never blank). */
const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  ANALYZING: "Analyzing",
  VALIDATING: "Validating",
  COMPLETED: "Analyzed",
  NO_STRATEGY: "Analyzed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};
const PENDING_ANALYSIS_STATUSES = new Set(["QUEUED", "ANALYZING", "VALIDATING"]);
const ANALYSIS_POLL_INTERVAL_MS = 4000;

/** Phase 4K follow-up — à-la-carte Whop lessons use the lesson-analysis job's own status vocabulary (see WhopCourseDetailPage's identical STATUS_LABELS/PENDING_STATUSES), a different set of states than project_source-based analysis above. */
const WHOP_LESSON_STATUS_LABELS: Record<string, string> = {
  NOT_ANALYZED: "Not analyzed",
  QUEUED: "Queued",
  ANALYZING: "Analyzing",
  RETRIEVING: "Retrieving",
  PREPARING_VIDEO: "Preparing",
  UPLOADING: "Uploading",
  VALIDATING: "Validating",
  ANALYZED: "Analyzed",
  FAILED: "Failed",
  AUTH_REQUIRED: "Needs Whop reconnect",
  CANCELLED: "Cancelled",
};
const WHOP_LESSON_PENDING_STATUSES = new Set(["QUEUED", "ANALYZING", "RETRIEVING", "PREPARING_VIDEO", "UPLOADING", "VALIDATING"]);

/** Phase 4I — every provider whose source is a single analyzable video, sharing one generic row/list/drawer. A future provider joins this union and this map, never a parallel list. */
type VideoProjectSource = YouTubeProjectSource | DiscordProjectSource;
const VIDEO_SOURCE_LABELS: Record<VideoProjectSource["provider"], string> = { YOUTUBE: "YouTube Video", DISCORD: "Discord Video" };

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
 * "/projects/:projectId/sources". Provider cards (Whop, YouTube, and as of
 * Phase 4I, Discord — all three operational) plus the existing Whop
 * sync/lesson-analysis UI and the two standalone Whop utility tools
 * (single-lesson diagnostic, find-my-user-id), all reusing the SAME
 * components/handlers App.tsx already wires up — no analysis behavior
 * changed, only where it's rendered.
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
  const navigate = useNavigate();
  const { state: projectState } = useResolvedProject(props.backendUrl, props.knoveraToken);
  const [sourcesState, setSourcesState] = useState<SourcesLoadState>({ phase: "idle" });
  const [showAddYouTubeDialog, setShowAddYouTubeDialog] = useState(false);
  const [showAddDiscordDialog, setShowAddDiscordDialog] = useState(false);
  const [batchImportProvider, setBatchImportProvider] = useState<"YOUTUBE" | "DISCORD" | "WHOP_LESSON" | null>(null);
  const [showAddYouTubeChannelDialog, setShowAddYouTubeChannelDialog] = useState(false);
  const [showConnectWhopCourseDialog, setShowConnectWhopCourseDialog] = useState(false);
  const [collections, setCollections] = useState<CatalogCollectionSummary[]>([]);
  const [alaCarteWhopLessons, setAlaCarteWhopLessons] = useState<AlaCarteWhopLessonSummary[]>([]);
  const [discordGuilds, setDiscordGuilds] = useState<DiscordGuildSummary[]>([]);
  const [discordConnectBusy, setDiscordConnectBusy] = useState(false);
  const [discordActionError, setDiscordActionError] = useState<string | null>(null);
  const [discordGuildBusyId, setDiscordGuildBusyId] = useState<number | null>(null);
  const [importChannelsGuild, setImportChannelsGuild] = useState<DiscordGuildSummary | null>(null);
  const [whopLessonBusyId, setWhopLessonBusyId] = useState<number | null>(null);
  const [whopLessonActionError, setWhopLessonActionError] = useState<string | null>(null);
  const [analysisStatuses, setAnalysisStatuses] = useState<Record<number, ProjectSourceAnalysisStatus>>({});
  const [analyzingSourceId, setAnalyzingSourceId] = useState<number | null>(null);
  const [analysisActionError, setAnalysisActionError] = useState<string | null>(null);
  const [viewingSourceId, setViewingSourceId] = useState<number | null>(null);

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

  async function loadCollections(url: string, token: string, projectId: number) {
    try {
      setCollections(await listSourceCollections(url, token, projectId));
    } catch {
      // Best-effort — the flat video-source list below still shows every
      // source regardless of collection, so a transient collections-list
      // failure never hides content, only the grouped-by-channel view.
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      setCollections([]);
      return;
    }
    void loadCollections(props.backendUrl, props.knoveraToken, projectState.project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, props.backendUrl, props.knoveraToken]);

  // Phase 4K-B — the connected-Discord-servers list is deployment-wide (see
  // db/discordGuildsRepo.ts's doc comment), never project-scoped — but it's
  // still loaded per Sources page visit, same best-effort convention as
  // loadCollections above, so a transient failure here never blocks the
  // rest of the page.
  async function loadDiscordGuilds(url: string, token: string) {
    try {
      setDiscordGuilds(await listDiscordGuilds(url, token));
    } catch {
      // Best-effort — see loadCollections's identical rationale above.
    }
  }

  useEffect(() => {
    if (!props.backendUrl || !props.knoveraToken) {
      setDiscordGuilds([]);
      return;
    }
    void loadDiscordGuilds(props.backendUrl, props.knoveraToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.backendUrl, props.knoveraToken]);

  function refreshDiscordGuilds() {
    if (props.backendUrl && props.knoveraToken) void loadDiscordGuilds(props.backendUrl, props.knoveraToken);
  }

  async function handleConnectDiscord() {
    if (!props.backendUrl || !props.knoveraToken || discordConnectBusy) return;
    setDiscordConnectBusy(true);
    setDiscordActionError(null);
    try {
      const { authorizeUrl } = await startDiscordConnect(props.backendUrl, props.knoveraToken);
      window.location.href = authorizeUrl;
    } catch (err) {
      setDiscordActionError(err instanceof CatalogApiError ? err.message : "Failed to start Discord connection. Please try again.");
      setDiscordConnectBusy(false);
    }
  }

  async function handleDisconnectDiscordGuild(guildId: number) {
    if (!props.backendUrl || !props.knoveraToken) return;
    setDiscordGuildBusyId(guildId);
    setDiscordActionError(null);
    try {
      await disconnectDiscordGuild(props.backendUrl, props.knoveraToken, guildId);
      refreshDiscordGuilds();
    } catch (err) {
      setDiscordActionError(err instanceof CatalogApiError ? err.message : "Failed to disconnect this Discord server. Please try again.");
    } finally {
      setDiscordGuildBusyId(null);
    }
  }

  // Phase 4K follow-up — à-la-carte Whop lessons are a genuinely separate
  // catalog concept from both "Whop Courses" (whopSources, below — full
  // course connections) and "Collections" (YouTube/Discord) — see
  // whopLessons.ts's doc comment. Best-effort load, same convention as
  // loadCollections: a transient failure here never hides the rest of the
  // Sources page.
  async function loadAlaCarteWhopLessons(url: string, token: string, projectId: number) {
    try {
      setAlaCarteWhopLessons(await listAlaCarteWhopLessons(url, token, projectId));
    } catch {
      // Best-effort — see loadCollections's identical rationale above.
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      setAlaCarteWhopLessons([]);
      return;
    }
    void loadAlaCarteWhopLessons(props.backendUrl, props.knoveraToken, projectState.project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, props.backendUrl, props.knoveraToken]);

  // Phase 4K — a project may now own any number of Whop courses (see
  // http/routes/whopCourses.ts); GET /api/projects/:projectId/sources
  // already returns one WhopProjectSource entry per course (backend was
  // already multi-course-capable here, see projectSources.ts), so this
  // only needed to change from .find() (one) to .filter() (all).
  const whopSources: WhopProjectSource[] =
    sourcesState.phase === "loaded" ? sourcesState.sources.filter((s): s is WhopProjectSource => s.provider === "WHOP") : [];
  // Phase 4H-A/4I — this project's persisted video sources (YouTube and, as
  // of Phase 4I, Discord), independent of whopSource above: a project can
  // have video sources with zero Whop courses, and vice versa (see the
  // Phase 4H-A PR description's project isolation rules). One shared list
  // for every video-shaped provider — never a parallel array/JSX block per
  // provider (see VIDEO_SOURCE_LABELS above).
  const videoSources: VideoProjectSource[] =
    sourcesState.phase === "loaded"
      ? sourcesState.sources.filter((s): s is VideoProjectSource => s.provider === "YOUTUBE" || s.provider === "DISCORD")
      : [];
  // Only a completed, successful lookup that found zero Whop sources counts
  // as "confirmed never had a Whop source" — idle (signed out / not yet
  // resolved), loading, and error all fall back to the pre-Phase-4C
  // behavior below (which includes CourseTable's own "Connect Whop"
  // prompt), so those states must never hide it. This is independent of
  // live Whop connection — see the component doc comment above. Gates the
  // Whop-specific CourseTable/DashboardSummary block and Diagnostic Tools
  // below — both are Whop utilities, unaffected by whether this project
  // also has video sources.
  const confirmedNeverHadWhopSource = sourcesState.phase === "loaded" && whopSources.length === 0;
  // The top empty-state box, by contrast, is about this project having NO
  // source at all — a project with video sources but no Whop course must
  // never show "No sources connected yet."
  const confirmedNeverHadAnySource = confirmedNeverHadWhopSource && videoSources.length === 0;
  const whopLiveConnected = props.connected;
  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;

  function refreshSources() {
    if (props.backendUrl && props.knoveraToken && resolvedProjectId != null) {
      void loadSources(props.backendUrl, props.knoveraToken, resolvedProjectId, { current: false });
    }
  }

  function refreshCollections() {
    if (props.backendUrl && props.knoveraToken && resolvedProjectId != null) {
      void loadCollections(props.backendUrl, props.knoveraToken, resolvedProjectId);
    }
  }

  function refreshAlaCarteWhopLessons() {
    if (props.backendUrl && props.knoveraToken && resolvedProjectId != null) void loadAlaCarteWhopLessons(props.backendUrl, props.knoveraToken, resolvedProjectId);
  }

  async function handleAnalyzeWhopLesson(lessonId: number, force = false) {
    if (!props.backendUrl || !props.knoveraToken) return;
    setWhopLessonBusyId(lessonId);
    setWhopLessonActionError(null);
    try {
      await enqueueAnalysisJobs(props.backendUrl, props.knoveraToken, [lessonId], force);
      refreshAlaCarteWhopLessons();
    } catch (err) {
      setWhopLessonActionError(err instanceof Error ? err.message : "Failed to start analysis.");
    } finally {
      setWhopLessonBusyId(null);
    }
  }

  const isTradingStrategies = projectState.phase === "resolved" && projectState.project.projectType === "TRADING_STRATEGIES";

  async function loadAnalysisStatus(sourceId: number) {
    if (!props.backendUrl || !props.knoveraToken || resolvedProjectId == null) return;
    try {
      const status = await getProjectSourceAnalysis(props.backendUrl, props.knoveraToken, resolvedProjectId, sourceId);
      setAnalysisStatuses((prev) => ({ ...prev, [sourceId]: status }));
    } catch {
      // Best-effort — a transient status-fetch failure leaves the row at
      // its last-known state rather than surfacing an error banner for a
      // read that will simply retry on the next poll tick.
    }
  }

  // Phase 4H-B — General Knowledge projects never fetch analysis status at
  // all (Analyze isn't available there yet — see isTradingStrategies
  // above), so this never invokes analysis endpoints for a project type
  // that can't use them.
  const videoSourceIdsKey = videoSources.map((s) => s.id).join(",");
  useEffect(() => {
    if (!isTradingStrategies || videoSources.length === 0) return;
    videoSources.forEach((source) => void loadAnalysisStatus(source.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSourceIdsKey, isTradingStrategies, resolvedProjectId]);

  // Polls only sources whose latest job is genuinely still in flight — never
  // a fabricated progress percentage, just a status re-check until it
  // reaches a terminal state.
  useEffect(() => {
    const pendingIds = videoSources.filter((s) => PENDING_ANALYSIS_STATUSES.has(analysisStatuses[s.id]?.job?.status ?? "")).map((s) => s.id);
    if (pendingIds.length === 0) return;
    const interval = setInterval(() => {
      pendingIds.forEach((id) => void loadAnalysisStatus(id));
    }, ANALYSIS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoSourceIdsKey, JSON.stringify(Object.fromEntries(Object.entries(analysisStatuses).map(([id, s]) => [id, s.job?.status])))]);

  async function handleAnalyze(sourceId: number, force = false) {
    if (!props.backendUrl || !props.knoveraToken || resolvedProjectId == null) return;
    setAnalysisActionError(null);
    setAnalyzingSourceId(sourceId);
    try {
      await analyzeProjectSource(props.backendUrl, props.knoveraToken, resolvedProjectId, sourceId, force);
      await loadAnalysisStatus(sourceId);
    } catch (err) {
      setAnalysisActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to start analysis. Please try again.");
    } finally {
      setAnalyzingSourceId(null);
    }
  }

  async function handleRetry(sourceId: number) {
    if (!props.backendUrl || !props.knoveraToken || resolvedProjectId == null) return;
    setAnalysisActionError(null);
    setAnalyzingSourceId(sourceId);
    try {
      await retryProjectSourceAnalysis(props.backendUrl, props.knoveraToken, resolvedProjectId, sourceId);
      await loadAnalysisStatus(sourceId);
    } catch (err) {
      setAnalysisActionError(err instanceof ProjectSourceAnalysisError ? err.message : "Failed to retry analysis. Please try again.");
    } finally {
      setAnalyzingSourceId(null);
    }
  }

  const viewingSource = viewingSourceId != null ? (videoSources.find((s) => s.id === viewingSourceId) ?? null) : null;
  const viewingStatus = viewingSourceId != null ? analysisStatuses[viewingSourceId] : undefined;

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
            {whopSources.length > 0
              ? `${whopSources.length} course${whopSources.length === 1 ? "" : "s"} connected — lessons synced and analyzed via Whop.`
              : sourcesState.phase !== "loaded" && whopLiveConnected
                ? `${props.courseTitle ?? "The Trading Accelerator"} — course lessons, synced and analyzed via Whop.`
                : "Connect a Whop course to sync and analyze its lessons."}
          </p>
          {!whopLiveConnected ? (
            <button type="button" className="knovera-provider-connect-button" onClick={props.onSignIn}>
              Connect Whop
            </button>
          ) : (
            <div className="knovera-provider-card-actions">
              <button
                type="button"
                className="knovera-provider-connect-button"
                onClick={() => setShowConnectWhopCourseDialog(true)}
                disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
              >
                + Connect Another Course
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setBatchImportProvider("WHOP_LESSON")}
                disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
              >
                Bulk Import Lessons
              </button>
            </div>
          )}
        </div>
        <div className="kv-card knovera-provider-card">
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <YouTubeIcon className="knovera-provider-icon" />
              <h3>YouTube</h3>
            </div>
          </div>
          <p className="knovera-provider-desc">Add public YouTube videos or a whole channel to this project.</p>
          <div className="knovera-provider-card-actions">
            <button
              type="button"
              className="knovera-provider-connect-button"
              onClick={() => setShowAddYouTubeDialog(true)}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Add YouTube Video
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => setShowAddYouTubeChannelDialog(true)}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Add Channel
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => setBatchImportProvider("YOUTUBE")}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Bulk Import
            </button>
          </div>
        </div>
        <div className={discordGuilds.length > 0 ? "kv-card knovera-provider-card operational" : "kv-card knovera-provider-card"}>
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <DiscordIcon className="knovera-provider-icon" />
              <h3>Discord</h3>
            </div>
            {discordGuilds.length > 0 ? (
              <span className="kv-badge kv-badge-accent">
                {discordGuilds.length} Server{discordGuilds.length === 1 ? "" : "s"} Connected
              </span>
            ) : (
              <span className="kv-badge kv-badge-muted">Not Connected</span>
            )}
          </div>
          <p className="knovera-provider-desc">
            {discordGuilds.length > 0
              ? "Import channels from a connected server, or add an individual video attachment below."
              : "Connect Discord to browse and import a server's channels, or add an individual video attachment."}
          </p>
          {discordActionError && (
            <p className="knovera-field-error" role="alert">
              {discordActionError}
            </p>
          )}
          {discordGuilds.length > 0 && (
            <ul className="knovera-discord-guild-list">
              {discordGuilds.map((guild) => (
                <li key={guild.id} className="knovera-discord-guild-row">
                  <span className="knovera-discord-guild-name">{guild.guildName}</span>
                  <div className="knovera-youtube-source-actions">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setImportChannelsGuild(guild)}
                      disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
                    >
                      Import Channels
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={discordGuildBusyId === guild.id}
                      onClick={() => void handleDisconnectDiscordGuild(guild.id)}
                    >
                      {discordGuildBusyId === guild.id ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="knovera-provider-card-actions">
            <button type="button" className="knovera-provider-connect-button" onClick={() => void handleConnectDiscord()} disabled={!props.backendUrl || !props.knoveraToken || discordConnectBusy}>
              {discordConnectBusy ? "Connecting…" : discordGuilds.length > 0 ? "+ Connect Another Server" : "Connect Discord"}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => setShowAddDiscordDialog(true)}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Add Discord Video
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => setBatchImportProvider("DISCORD")}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Bulk Import
            </button>
          </div>
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
          <p>Connect Whop, add a YouTube video, or add a Discord video to add content.</p>
        </div>
      )}

      {whopSources.length > 0 && (
        <>
          <h2 className="knovera-section-title">Whop Courses</h2>
          <div className="knovera-project-grid">
            {whopSources.map((course) => (
              <div key={course.courseId} className="kv-card knovera-project-card">
                <div className="knovera-project-card-top">
                  <div>
                    <h2>{course.name}</h2>
                    <p className="knovera-project-card-source">
                      {course.lessonCount} lesson{course.lessonCount === 1 ? "" : "s"} · {course.analyzedLessonCount} analyzed
                    </p>
                  </div>
                </div>
                <div className="knovera-project-card-footer">
                  <button type="button" className="knovera-open-link" onClick={() => navigate(`/projects/${resolvedProjectId}/whop-courses/${course.courseId}`)}>
                    Open
                    <span className="knovera-cta-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {alaCarteWhopLessons.length > 0 && (
        <>
          <h2 className="knovera-section-title">À-la-carte Whop</h2>
          <p className="knovera-project-card-source">
            Individually imported lessons — never a full course. Connect the course instead to see all of its lessons.
          </p>
          {whopLessonActionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{whopLessonActionError}</p>
            </div>
          )}
          <ul className="knovera-youtube-source-list">
            {alaCarteWhopLessons.map((lesson) => {
              const isPending = WHOP_LESSON_PENDING_STATUSES.has(lesson.status);
              const isFailed = lesson.status === "FAILED";
              const isDone = lesson.status === "ANALYZED";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";
              const busy = whopLessonBusyId === lesson.id;
              return (
                <li key={lesson.id} className="kv-card knovera-youtube-source-row">
                  <div className="knovera-youtube-source-main">
                    <span className="knovera-youtube-source-label">{lesson.courseTitle}</span>
                    <span className="knovera-youtube-source-title">{lesson.title}</span>
                  </div>
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{WHOP_LESSON_STATUS_LABELS[lesson.status] ?? lesson.status}</span>
                    {lesson.status === "NOT_ANALYZED" && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeWhopLesson(lesson.id)}>
                        {busy ? "Starting…" : "Analyze"}
                      </button>
                    )}
                    {isPending && <span className="hint">Working…</span>}
                    {isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeWhopLesson(lesson.id)}>
                        {busy ? "Retrying…" : "Retry"}
                      </button>
                    )}
                    {isDone && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeWhopLesson(lesson.id, true)}>
                        {busy ? "Starting…" : "Re-analyze"}
                      </button>
                    )}
                    <a href={lesson.sourceUrl} target="_blank" rel="noreferrer" className="link-button">
                      Open on Whop
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {collections.length > 0 && (
        <>
          <h2 className="knovera-section-title">Collections</h2>
          <div className="knovera-project-grid">
            {collections.map((collection) => (
              <div key={collection.id} className="kv-card knovera-project-card">
                <div className="knovera-project-card-top">
                  <div>
                    <h2>{collection.title}</h2>
                    <p className="knovera-project-card-source">
                      {collection.provider === "YOUTUBE" ? "YouTube Channel" : "Discord Collection"} · {collection.itemCount} item{collection.itemCount === 1 ? "" : "s"} · {collection.analyzedCount} analyzed
                    </p>
                    {collection.status === "SYNC_FAILED" && collection.sanitizedError && <p className="knovera-field-error">{collection.sanitizedError}</p>}
                  </div>
                </div>
                <div className="knovera-project-card-footer">
                  <button type="button" className="knovera-open-link" onClick={() => navigate(`/projects/${resolvedProjectId}/collections/${collection.id}`)}>
                    Open
                    <span className="knovera-cta-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {videoSources.length > 0 && (
        <>
          <h2 className="knovera-section-title">Video Sources</h2>
          {analysisActionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{analysisActionError}</p>
            </div>
          )}
          <ul className="knovera-youtube-source-list">
            {videoSources.map((source) => {
              const status = analysisStatuses[source.id];
              const job = status?.job ?? null;
              const analysis = status?.analysis ?? null;
              const busy = analyzingSourceId === source.id;
              const isPending = !!job && PENDING_ANALYSIS_STATUSES.has(job.status);
              const isFailed = job?.status === "FAILED";
              const isDone = !!analysis;
              const badgeLabel = !isTradingStrategies ? "Added" : job ? (ANALYSIS_STATUS_LABELS[job.status] ?? "Added") : isDone ? "Analyzed" : "Not analyzed";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";

              return (
                <li key={source.id} className="kv-card knovera-youtube-source-row">
                  <div className="knovera-youtube-source-main">
                    <span className="knovera-youtube-source-label">{VIDEO_SOURCE_LABELS[source.provider]}</span>
                    <span className="knovera-youtube-source-title">{source.title ?? source.sourceUrl}</span>
                  </div>
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{badgeLabel}</span>
                    {isTradingStrategies && !job && !analysis && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(source.id)}>
                        {busy ? "Starting…" : "Analyze"}
                      </button>
                    )}
                    {isTradingStrategies && isPending && <span className="hint">Working…</span>}
                    {isTradingStrategies && isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleRetry(source.id)}>
                        {busy ? "Retrying…" : "Retry"}
                      </button>
                    )}
                    {isTradingStrategies && isDone && (
                      <>
                        <button type="button" className="link-button" onClick={() => setViewingSourceId(source.id)}>
                          View
                        </button>
                        <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(source.id, true)}>
                          {busy ? "Starting…" : "Re-analyze"}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {props.backendUrl && !confirmedNeverHadWhopSource && (
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
      )}
      {props.courseErrorMessage && <div className="error-box">{props.courseErrorMessage}</div>}

      {/* Phase 4C correction: these are Whop-specific utilities (single-lesson
          diagnostic, find-my-user-id) — legacy implementation UI that has no
          purpose on a project confirmed to have no Whop course. Hidden only
          on that definitive signal, same as CourseTable above, so it never
          disappears mid-load or pre-auth (where it's still the way to sign
          in) — and never hidden for MasterMind, which does have a source.
          Phase 4H-A/4I: this gate stays Whop-specific (confirmedNeverHadWhopSource,
          not confirmedNeverHadAnySource) — a project with only video
          sources (YouTube/Discord) still has no Whop course to run these
          Whop utilities against. */}
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

      {showAddDiscordDialog && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <AddDiscordVideoDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          onClose={() => setShowAddDiscordDialog(false)}
          onAdded={() => {
            setShowAddDiscordDialog(false);
            refreshSources();
          }}
        />
      )}

      {batchImportProvider && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <BatchImportDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          provider={batchImportProvider}
          onClose={() => setBatchImportProvider(null)}
          onImported={batchImportProvider === "WHOP_LESSON" ? refreshAlaCarteWhopLessons : refreshSources}
        />
      )}

      {showAddYouTubeChannelDialog && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <AddYouTubeChannelDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          onClose={() => setShowAddYouTubeChannelDialog(false)}
          onAdded={() => {
            setShowAddYouTubeChannelDialog(false);
            refreshCollections();
            refreshSources();
          }}
        />
      )}

      {importChannelsGuild && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <ImportDiscordChannelsDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          guildId={importChannelsGuild.id}
          guildName={importChannelsGuild.guildName}
          onClose={() => setImportChannelsGuild(null)}
          onImported={() => {
            setImportChannelsGuild(null);
            refreshCollections();
          }}
        />
      )}

      {showConnectWhopCourseDialog && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <ConnectWhopCourseDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          onClose={() => setShowConnectWhopCourseDialog(false)}
          onConnected={() => {
            setShowConnectWhopCourseDialog(false);
            refreshSources();
            // A newly-connected course may absorb lessons previously shown
            // à la carte (spec: "à-la-carte → later course" dedup) — refresh
            // so any such item moves out of this list immediately.
            refreshAlaCarteWhopLessons();
          }}
        />
      )}

      <ProjectSourceAnalysisDrawer
        source={viewingSource}
        job={viewingStatus?.job ?? null}
        analysis={viewingStatus?.analysis ?? null}
        loading={false}
        onClose={() => setViewingSourceId(null)}
      />
    </div>
  );
}
