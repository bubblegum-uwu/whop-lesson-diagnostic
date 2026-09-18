import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getWhopCourseDashboard, refreshWhopCourse, CatalogApiError, type WhopCourseSummary } from "../lib/catalogApi";
import {
  getAuthStatus,
  enqueueAnalysisJobs,
  retryAnalysisJob,
  cancelAnalysisJob,
  getLessonAnalysisJson,
  subscribeAnalysisEvents,
  type AnalysisSummary,
  type CourseLessonSummary,
} from "../lib/courseApi";
import { CourseTable } from "../components/CourseTable";

export interface WhopCourseDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; course: WhopCourseSummary; summary: AnalysisSummary | null; lessons: CourseLessonSummary[] }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

/**
 * "/projects/:projectId/whop-courses/:courseId" — Phase 4K follow-up. The
 * SINGLE home for a Whop course's rich management UI: the same
 * CourseTable/DashboardSummary/LessonDetailDrawer experience the original
 * single-course app had, now scoped to whichever course was actually
 * opened, never a globally "the" course (see catalogApi.ts's
 * getWhopCourseDashboard doc comment — Phase 4K's multi-course model means
 * a project can own any number of Whop courses, and opening Course B must
 * never show Course A's data).
 *
 * State resets synchronously on every courseId change (not just inside the
 * async load) so navigating from one course straight to another never
 * renders the previous course's lessons while the new course's fetch is
 * still in flight — the same pattern CourseIntelligence/SynthesisSetDetailPage
 * already use for their own per-entity state.
 *
 * Two distinct kinds of (re)load:
 *  - An ENTITY-CHANGING load (initial mount, projectId/courseId change)
 *    blanks the page to "Loading course…" — there is no previous course's
 *    CourseTable worth preserving.
 *  - A BACKGROUND refresh (SSE analysis events, Analyze/Retry/Cancel/
 *    Refresh Course follow-ups) must NOT unmount the already-rendered
 *    CourseTable — it owns its own local UI state (search, filters,
 *    selection, pagination, the open lesson detail drawer) that a
 *    "loading" blank-out would silently reset on every live update while
 *    an analysis run is in progress. Background refreshes replace only the
 *    `course`/`summary`/`lessons` data in place, in the same "loaded"
 *    phase, so CourseTable stays mounted throughout.
 *
 * Every async response (entity load or background refresh alike) is
 * fenced by `activeCourseKeyRef` — a request kicked off for Course A that
 * resolves after the operator has already navigated to Course B is
 * discarded rather than committed, so a slow in-flight request can never
 * overwrite a different course's already-rendered page (see
 * WhopCourseDetailPage.test.tsx's stale-background-response regression
 * test).
 *
 * The course dashboard (persisted data) and the live Whop connection
 * status are loaded independently: a transient `getAuthStatus()` failure
 * is best-effort UI-capability state only and must never hide an
 * already-successfully-loaded course dashboard.
 *
 * Provider-level Whop actions (Connect/Disconnect) live on the Sources
 * page's Whop provider card, not here — CourseTable itself no longer
 * exposes a Disconnect action (see CourseTableProps' doc comment). This
 * page's own "Connect Whop" entry points send the operator to Sources
 * rather than duplicating the OAuth-kickoff mechanics App.tsx already owns.
 */
export function WhopCourseDetailPage({ backendUrl, knoveraToken }: WhopCourseDetailPageProps) {
  const navigate = useNavigate();
  const { courseId: courseIdParam } = useParams<{ courseId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [connected, setConnected] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const courseId = courseIdParam ? Number(courseIdParam) : NaN;
  const courseKey = `${resolvedProjectId ?? ""}:${courseId}`;

  // The only course/project this page instance is currently allowed to
  // commit fetched state for. Every async handler below reads this
  // ref — never a captured variable — at the moment its response arrives,
  // so a request that outlives its own course (background refresh or
  // otherwise) is discarded instead of clobbering whatever course is
  // actually on screen by then.
  const activeCourseKeyRef = useRef<string>(courseKey);

  /**
   * Fetches this course's persisted dashboard data. `showLoading: true` is
   * for an entity-changing load (blanks the page to "loading", and a
   * failure becomes a page-level error state); `showLoading: false` is a
   * background refresh that leaves the current "loaded" UI mounted and
   * only swaps in fresh data on success — a background failure is
   * swallowed rather than blanking out an already-working page (not-found
   * is the one exception: the course genuinely no longer exists, so it
   * always takes effect).
   */
  async function loadDashboard(url: string, token: string, projectId: number, key: string, options: { showLoading: boolean }) {
    if (options.showLoading) setState({ phase: "loading" });
    try {
      const dashboard = await getWhopCourseDashboard(url, token, projectId, courseId);
      if (activeCourseKeyRef.current !== key) return;
      setState({ phase: "loaded", course: dashboard.course, summary: dashboard.summary, lessons: dashboard.lessons });
    } catch (err) {
      if (activeCourseKeyRef.current !== key) return;
      if (err instanceof CatalogApiError && err.type === "course_not_found") {
        setState({ phase: "not_found" });
      } else if (options.showLoading) {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load course." });
      }
    }
  }

  /**
   * Live Whop provider connection status — best-effort, deliberately
   * separate from `loadDashboard`. This is UI-capability state (whether
   * Analyze/Retry/Re-analyze should be enabled), never a gate on viewing
   * already-persisted course/lesson/analysis data. A transient failure
   * here leaves whatever connection state was last known rather than
   * hiding or erroring the course page.
   */
  async function loadConnectionState(url: string, token: string, key: string) {
    try {
      const authStatus = await getAuthStatus(url, token);
      if (activeCourseKeyRef.current !== key) return;
      setConnected(authStatus.connected);
      setAuthRequired(authStatus.status === "auth_required");
    } catch {
      // Best-effort — see doc comment above.
    }
  }

  useEffect(() => {
    activeCourseKeyRef.current = courseKey;
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(courseId)) {
      setState({ phase: "idle" });
      return;
    }
    // Reset synchronously — a courseId change (Course A -> Course B) must
    // never keep showing Course A's lessons, error banner, or busy state
    // while the new course's fetch is in flight.
    setState({ phase: "loading" });
    setActionError(null);
    setSyncing(false);
    void loadDashboard(backendUrl, knoveraToken, resolvedProjectId, courseKey, { showLoading: false });
    void loadConnectionState(backendUrl, knoveraToken, courseKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  // Live-notification layer, scoped to this page's own courseId: on any
  // analysis event, refresh THIS course's dashboard in the background —
  // mirrors the app's former global refresh, but never leaks into a
  // course the operator isn't currently viewing (activeCourseKeyRef fences
  // a stale event's response the same way it fences every other async
  // refresh), and never unmounts the already-rendered CourseTable.
  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(courseId)) return undefined;
    const url = backendUrl;
    const token = knoveraToken;
    const projectId = resolvedProjectId;
    const key = courseKey;
    const unsubscribe = subscribeAnalysisEvents(url, token, () => {
      void loadDashboard(url, token, projectId, key, { showLoading: false });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) {
      void loadDashboard(backendUrl, knoveraToken, resolvedProjectId, courseKey, { showLoading: false });
      void loadConnectionState(backendUrl, knoveraToken, courseKey);
    }
  }

  function goToSources() {
    navigate(`/projects/${resolvedProjectId}/sources`);
  }

  async function handleRefreshCourse() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    const key = courseKey;
    setSyncing(true);
    setActionError(null);
    try {
      await refreshWhopCourse(backendUrl, knoveraToken, resolvedProjectId, courseId);
      if (activeCourseKeyRef.current !== key) return;
      refresh();
    } catch (err) {
      if (activeCourseKeyRef.current !== key) return;
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh course.");
    } finally {
      if (activeCourseKeyRef.current === key) setSyncing(false);
    }
  }

  async function handleEnqueue(lessonIds: number[], force = false) {
    if (!backendUrl || !knoveraToken) return;
    const key = courseKey;
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, lessonIds, force);
      if (activeCourseKeyRef.current !== key) return;
      refresh();
    } catch (err) {
      if (activeCourseKeyRef.current !== key) return;
      setActionError(err instanceof Error ? err.message : "Failed to queue analysis.");
    }
  }

  async function handleRetry(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    const key = courseKey;
    try {
      await retryAnalysisJob(backendUrl, knoveraToken, jobId);
      if (activeCourseKeyRef.current !== key) return;
      refresh();
    } catch (err) {
      if (activeCourseKeyRef.current !== key) return;
      setActionError(err instanceof Error ? err.message : "Failed to retry job.");
    }
  }

  async function handleCancel(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    const key = courseKey;
    await cancelAnalysisJob(backendUrl, knoveraToken, jobId);
    if (activeCourseKeyRef.current !== key) return;
    refresh();
  }

  async function handleLoadAnalysis(lessonId: number): Promise<unknown | null> {
    if (!backendUrl || !knoveraToken) return null;
    return getLessonAnalysisJson(backendUrl, knoveraToken, lessonId);
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      <button type="button" className="link-button" onClick={goToSources}>
        ← Sources
      </button>

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading course…</p>}

      {state.phase === "not_found" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>This Whop course doesn't exist.</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {state.phase === "loaded" && (
        <CourseTable
          courseTitle={state.course.name}
          lessons={state.lessons}
          connected={connected}
          syncing={syncing}
          authRequired={authRequired}
          lastSyncedAt={state.course.lastSyncedAt}
          summary={state.summary}
          onSignIn={goToSources}
          onSync={() => void handleRefreshCourse()}
          onEnqueue={(lessonIds, force) => void handleEnqueue(lessonIds, force)}
          onRetry={(jobId) => void handleRetry(jobId)}
          onCancel={(jobId) => void handleCancel(jobId)}
          onLoadAnalysis={handleLoadAnalysis}
        />
      )}
      {actionError && <div className="error-box">{actionError}</div>}
    </div>
  );
}
