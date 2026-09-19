import { useEffect, useRef, useState } from "react";
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
  /** LIVE Whop provider-connection state (GET /api/auth/status) — distinct from whether this project has ever had a persisted source, see sourcesState below. Drives the provider card's Connected/Not Connected badge. */
  connected: boolean;
  /** A Connect/Disconnect Whop action failed — provider-level only; a course's own sync/analyze errors surface on its dedicated Whop Course Detail page instead (see WhopCourseDetailPage.tsx). */
  providerErrorMessage: string | null;
  onSignIn: () => void;
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
 * "/projects/:projectId/sources" — COLLECTION/GROUP-ONLY (Phase 4L taxonomy
 * correction, reaffirmed by the Phase 4K follow-up that moved the rich
 * per-course lesson UI onto its own WhopCourseDetailPage): provider cards
 * (Whop, YouTube, Discord), one card per connected Whop course, the
 * Collections/à-la-carte grid, and the two standalone Whop utility tools
 * (single-lesson diagnostic, find-my-user-id). No individual source or
 * lesson row, and no per-course management UI, ever renders on this page —
 * see the JSX comment above the Collections section for the full
 * PERSISTED-vs-DERIVED group model.
 *
 * Loads this project's real connected sources from `GET
 * /api/projects/:projectId/sources` (via the same `useResolvedProject` hook
 * ProjectHeader uses) to keep the Whop Courses grid and Diagnostic Tools
 * section below from ever rendering for a project that has never owned a
 * Whop course — see `confirmedNeverHadWhopSource`/`confirmedNeverHadAnySource`
 * below.
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

  // The only project this page instance is currently allowed to commit
  // fetched state for — shared across sources/collections/à-la-carte
  // lessons. Set synchronously whenever the resolved project changes (see
  // each dataset's own effect below), so a request kicked off for Project A
  // that resolves after the operator has navigated to Project B is
  // discarded rather than clobbering Project B's already-rendered page —
  // same pattern WhopCourseDetailPage.tsx uses for its own per-entity state.
  const activeProjectIdRef = useRef<number | null>(null);
  // Bumped by every loadSources/loadCollections/loadAlaCarteWhopLessons call
  // respectively. A response only commits if it is BOTH for the
  // still-active project (activeProjectIdRef) AND still the most recent
  // request for that dataset — this is what stops a slow initial load from
  // overwriting a faster post-mutation background refresh. Example: the
  // Sources page mounts and starts a slow initial GET /collections; before
  // it resolves, the operator adds a YouTube source, whose own
  // refreshSourceCatalog() kicks off a second, faster GET /collections that
  // resolves first and shows the new card; without this fence, the slow
  // initial request would then land and call setCollections([]),
  // silently reverting the page back to "no collections" — the exact
  // stale-UI symptom this file's earlier fix (refreshSourceCatalog) was
  // meant to eliminate, just reached a different way. See
  // SourcesPage.catalog.test.tsx's stale-request regression tests.
  //
  // Protection is required at BOTH ends of a request, not just completion:
  // each loader also checks activeProjectIdRef BEFORE doing anything
  // observable (before bumping its version ref or setting a "loading"
  // state) — a mutation dialog's onAdded/onImported closure captures
  // whichever project was active when the dialog was opened, so a POST
  // that was still in flight when the operator navigated to a different
  // project resolves into a closure for a project that is no longer
  // active. Without the start-of-request check, that stale closure could
  // still advance the CURRENT project's request-version counter and flash
  // "Loading sources…" over an already-loaded, unrelated project, even
  // though its own eventual response would correctly get discarded by the
  // completion-time check above.
  const sourcesRequestVersionRef = useRef(0);
  const collectionsRequestVersionRef = useRef(0);
  const alaCarteWhopLessonsRequestVersionRef = useRef(0);

  async function loadSources(url: string, token: string, projectId: number) {
    // Reject a stale caller BEFORE it can do anything observable — a
    // mutation dialog's onAdded closure captures the project id at the
    // time it was rendered, so a POST that was still in flight when the
    // operator navigated to a different project resolves into a closure
    // for a project that is no longer active. Checking this first stops
    // that stale caller from bumping the request-version counter or
    // flashing "Loading sources…" over whichever project's request IS
    // still legitimately in flight — it must be a complete no-op.
    if (activeProjectIdRef.current !== projectId) return;
    const requestVersion = ++sourcesRequestVersionRef.current;
    function isStale() {
      return activeProjectIdRef.current !== projectId || sourcesRequestVersionRef.current !== requestVersion;
    }
    setSourcesState({ phase: "loading" });
    try {
      const result = await getProjectSources(url, token, projectId);
      if (isStale()) return;
      setSourcesState({ phase: "loaded", sources: result.sources });
    } catch (err) {
      if (isStale()) return;
      setSourcesState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load sources." });
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      activeProjectIdRef.current = null;
      setSourcesState({ phase: "idle" });
      return;
    }
    activeProjectIdRef.current = projectState.project.id;
    void loadSources(props.backendUrl, props.knoveraToken, projectState.project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, props.backendUrl, props.knoveraToken]);

  async function loadCollections(url: string, token: string, projectId: number) {
    // See loadSources's identical guard above — a stale caller (e.g. a
    // mutation dialog's onAdded closure whose POST finished after the
    // operator navigated away) must be a complete no-op, never advancing
    // the request-version counter.
    if (activeProjectIdRef.current !== projectId) return;
    const requestVersion = ++collectionsRequestVersionRef.current;
    try {
      const result = await listSourceCollections(url, token, projectId);
      if (activeProjectIdRef.current !== projectId || collectionsRequestVersionRef.current !== requestVersion) return;
      setCollections(result);
    } catch {
      // Best-effort — a transient collections-list failure only hides the
      // Collections/Uncollected cards below, never the rest of the page.
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      activeProjectIdRef.current = null;
      setCollections([]);
      return;
    }
    activeProjectIdRef.current = projectState.project.id;
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
    // See loadSources's identical guard above.
    if (activeProjectIdRef.current !== projectId) return;
    const requestVersion = ++alaCarteWhopLessonsRequestVersionRef.current;
    try {
      const result = await listAlaCarteWhopLessons(url, token, projectId);
      if (activeProjectIdRef.current !== projectId || alaCarteWhopLessonsRequestVersionRef.current !== requestVersion) return;
      setAlaCarteWhopLessons(result);
    } catch {
      // Best-effort — see loadCollections's identical rationale above.
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !props.backendUrl || !props.knoveraToken) {
      activeProjectIdRef.current = null;
      setAlaCarteWhopLessons([]);
      return;
    }
    activeProjectIdRef.current = projectState.project.id;
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
  // behavior below (the Whop provider card's own "Connect Whop" prompt),
  // so those states must never hide it. This is independent of live Whop
  // connection — see the component doc comment above. Gates the Whop
  // Courses grid and Diagnostic Tools below — both are Whop utilities,
  // unaffected by whether this project also has video sources.
  const confirmedNeverHadWhopSource = sourcesState.phase === "loaded" && whopSources.length === 0;
  // The top empty-state box, by contrast, is about this project having NO
  // source at all — a project with video sources but no Whop course must
  // never show "No sources connected yet."
  const confirmedNeverHadAnySource = confirmedNeverHadWhopSource && videoSources.length === 0;
  const whopLiveConnected = props.connected;
  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;

  function refreshSources() {
    if (props.backendUrl && props.knoveraToken && resolvedProjectId != null) {
      void loadSources(props.backendUrl, props.knoveraToken, resolvedProjectId);
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

  /**
   * The Sources page is COLLECTION/GROUP-ONLY (see the JSX comment above the
   * Collections section): the card the operator actually sees after adding
   * a YouTube/Discord source almost always comes from `collections` (GET
   * .../collections, which merges persisted source_collections rows AND
   * DERIVED groups computed from project_source_origins — see the backend's
   * derivedSourceGroupsRepo.ts doc comment), never from `sources` directly.
   * A raw project_sources add — manual YouTube/Discord, batch import, or a
   * Discord-channel-scan import — always lands as a DERIVED group (Manual
   * YouTube / a channel's own card / Unclassified) with no source_collections
   * row of its own, so refreshing `sources` alone leaves that card
   * invisible until a hard reload re-runs both loads. `sources` itself
   * still needs its own refresh too — it drives `confirmedNeverHadAnySource`
   * (the top empty-state box) and ImportDiscordChannelDialog's
   * existingYouTubeExternalIds dedup preview, neither of which `collections`
   * covers. Every mutation that can add/remove a project_sources row calls
   * this, not refreshSources() alone.
   */
  function refreshSourceCatalog() {
    refreshSources();
    refreshCollections();
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
              <button type="button" className="link-button" onClick={props.onDisconnect}>
                Disconnect Whop
              </button>
            </div>
          )}
          {props.providerErrorMessage && <p className="knovera-field-error">{props.providerErrorMessage}</p>}
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

      {/* Phase 4C correction: these are Whop-specific utilities (single-lesson
          diagnostic, find-my-user-id) — legacy implementation UI that has no
          purpose on a project confirmed to have no Whop course. Hidden only
          on that definitive signal, same as the Whop Courses grid above, so
          it never disappears mid-load or pre-auth (where it's still the way
          to sign in) — and never hidden for MasterMind, which does have a source.
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
            refreshSourceCatalog();
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
            refreshSourceCatalog();
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
          onImported={batchImportProvider === "WHOP_LESSON" ? refreshAlaCarteWhopLessons : refreshSourceCatalog}
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
            refreshSourceCatalog();
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
          onImported={refreshSourceCatalog}
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
