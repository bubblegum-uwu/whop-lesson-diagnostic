import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { WhopIcon, YouTubeIcon, DiscordIcon } from "../components/ProviderIcons";
import { FindWhopUserId, type FindWhopUserIdState } from "../components/FindWhopUserId";
import { ConfigForm } from "../components/ConfigForm";
import { DiagnosticResult } from "../components/DiagnosticResult";
import { ErrorResult } from "../components/ErrorResult";
import { AnalyzeLesson } from "../components/AnalyzeLesson";
import { AddYouTubeVideoDialog } from "../components/AddYouTubeVideoDialog";
import { AddDiscordVideoDialog } from "../components/AddDiscordVideoDialog";
import { DiscordLinkStatusPanel } from "../components/DiscordLinkStatusPanel";
import { BatchImportDialog } from "../components/BatchImportDialog";
import { AddYouTubeChannelDialog } from "../components/AddYouTubeChannelDialog";
import { ImportDiscordChannelDialog } from "../components/ImportDiscordChannelDialog";
import { ConnectWhopCourseDialog } from "../components/ConnectWhopCourseDialog";
import type { DiagnosticDisplayPayload } from "../lib/diagnosticPayload";
import type { LessonFetchOutcome } from "../lib/whopApi";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getProjectSources, type ProjectSource, type WhopProjectSource, type YouTubeProjectSource, type DiscordProjectSource } from "../lib/sourcesApi";
import {
  listSourceCollections,
  listAlaCarteWhopLessons,
  catalogGroupTypeLabel,
  catalogGroupOriginLine,
  type CatalogCollectionSummary,
  type AlaCarteWhopLessonSummary,
} from "../lib/catalogApi";

/** Phase 4I — every provider whose source is a single analyzable video. A future provider joins this union. */
type VideoProjectSource = YouTubeProjectSource | DiscordProjectSource;

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
  /** LIVE Whop provider-connection state (GET /api/auth/status) — distinct from whether this project has ever had a persisted source, see sourcesState below. Drives the provider card's Connected/Not Connected badge. */
  connected: boolean;
  courseErrorMessage: string | null;
  onSignIn: () => void;
  /** Provider-level "Disconnect Whop" — see the Whop provider card's connected-actions block below. Never a per-course action (see WhopCourseDetailPage's own, course-scoped Refresh Course instead). */
  onDisconnect: () => void;

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
  const [showImportDiscordChannelDialog, setShowImportDiscordChannelDialog] = useState(false);
  const [showConnectWhopCourseDialog, setShowConnectWhopCourseDialog] = useState(false);
  const [collections, setCollections] = useState<CatalogCollectionSummary[]>([]);
  const [alaCarteWhopLessons, setAlaCarteWhopLessons] = useState<AlaCarteWhopLessonSummary[]>([]);

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
      // Best-effort — a transient collections-list failure only hides the
      // Collections/Uncollected cards below, never the rest of the page.
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
  // Phase 4K-C — the current YouTube externalIds this project already has,
  // for ImportDiscordChannelDialog's client-side preview estimate only
  // (the backend commit call remains the authoritative dedup source).
  const existingYouTubeExternalIds = new Set(videoSources.filter((s) => s.provider === "YOUTUBE").map((s) => s.externalId));
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
              {/* Phase 4K-D follow-up — the ONLY "Disconnect Whop" entry point in the
                  app now that the legacy inline CourseTable (which used to render
                  its own Disconnect Whop button) no longer renders on this page.
                  This disconnects the whole Whop PROVIDER connection — never a
                  single course — so it belongs here, not on any one course's own
                  detail page (see WhopCourseDetailPage.tsx's course-scoped
                  "Refresh Course" instead). */}
              <button type="button" className="link-button" onClick={props.onDisconnect}>
                Disconnect Whop
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
        <div className="kv-card knovera-provider-card">
          <div className="knovera-provider-card-top">
            <div className="knovera-provider-card-icon-row">
              <DiscordIcon className="knovera-provider-icon" />
              <h3>Discord</h3>
            </div>
          </div>
          <p className="knovera-provider-desc">Add a video attachment shared in Discord to this project.</p>
          <div className="knovera-provider-card-actions">
            <button
              type="button"
              className="knovera-provider-connect-button"
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
            <button
              type="button"
              className="link-button"
              onClick={() => setShowImportDiscordChannelDialog(true)}
              disabled={!props.backendUrl || !props.knoveraToken || resolvedProjectId == null}
            >
              Import YouTube from a Channel
            </button>
          </div>
          <DiscordLinkStatusPanel backendUrl={props.backendUrl} knoveraToken={props.knoveraToken} />
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

      {/*
       * Phase 4L taxonomy correction — the main Sources page is
       * COLLECTION/GROUP-ONLY: no individual source row of any kind
       * renders here. `collections` (from listSourceCollections) already
       * includes every PERSISTED source_collections row AND every DERIVED
       * group with current members (see CatalogCollectionSummary's doc
       * comment) — a YouTube video discovered by scanning a Discord
       * channel renders as its own "YOUTUBE · CHANNEL / Discord ·
       * #channel" card here, never lumped into a generic "Uncollected/
       * À-la-carte" bucket keyed off collection_id IS NULL. The Whop
       * à-la-carte card below is the one exception kept separate from
       * `collections` — Whop lessons live in the `lessons` table, never
       * `project_sources`, so they were never part of that catalog to
       * begin with (see whopLessonImportsRepo.ts's doc comment).
       */}
      {(collections.length > 0 || alaCarteWhopLessons.length > 0) && (
        <>
          <h2 className="knovera-section-title">Collections</h2>
          <div className="knovera-project-grid">
            {collections.map((collection) => (
              <div key={collection.groupKey} className="kv-card knovera-project-card">
                <div className="knovera-project-card-top">
                  <div>
                    <h2>{catalogGroupTypeLabel(collection)}</h2>
                    <p className="knovera-project-card-source">
                      {catalogGroupOriginLine(collection)} · {collection.itemCount} item{collection.itemCount === 1 ? "" : "s"} · {collection.analyzedCount} analyzed
                    </p>
                    {collection.status === "SYNC_FAILED" && collection.sanitizedError && <p className="knovera-field-error">{collection.sanitizedError}</p>}
                  </div>
                </div>
                <div className="knovera-project-card-footer">
                  <button
                    type="button"
                    className="knovera-open-link"
                    onClick={() => navigate(`/projects/${resolvedProjectId}/collections/${encodeURIComponent(collection.groupKey)}`)}
                  >
                    Open
                    <span className="knovera-cta-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              </div>
            ))}

            {alaCarteWhopLessons.length > 0 && (
              <div className="kv-card knovera-project-card">
                <div className="knovera-project-card-top">
                  <div>
                    <h2>WHOP · À-LA-CARTE</h2>
                    <p className="knovera-project-card-source">
                      Individual Whop Content · {alaCarteWhopLessons.length} item{alaCarteWhopLessons.length === 1 ? "" : "s"} ·{" "}
                      {alaCarteWhopLessons.filter((l) => l.status === "ANALYZED").length} analyzed
                    </p>
                  </div>
                </div>
                <div className="knovera-project-card-footer">
                  <button type="button" className="knovera-open-link" onClick={() => navigate(`/projects/${resolvedProjectId}/whop-ala-carte`)}>
                    Open
                    <span className="knovera-cta-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
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

      {showImportDiscordChannelDialog && props.backendUrl && props.knoveraToken && resolvedProjectId != null && (
        <ImportDiscordChannelDialog
          backendUrl={props.backendUrl}
          knoveraToken={props.knoveraToken}
          projectId={resolvedProjectId}
          existingYouTubeExternalIds={existingYouTubeExternalIds}
          onClose={() => setShowImportDiscordChannelDialog(false)}
          onImported={refreshSources}
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
    </div>
  );
}
