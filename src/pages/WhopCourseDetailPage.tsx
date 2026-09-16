import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { useResolvedProject } from "../lib/useResolvedProject";
import { getWhopCourseDashboard, refreshWhopCourse, CatalogApiError, type WhopCourseSummary } from "../lib/catalogApi";
import { getAuthStatus, enqueueAnalysisJobs, retryAnalysisJob, cancelAnalysisJob, getLessonAnalysisJson, type CourseLessonSummary, type AnalysisSummary } from "../lib/courseApi";
import { DashboardSummary } from "../components/DashboardSummary";
import { CourseTable } from "../components/CourseTable";

export interface WhopCourseDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; course: WhopCourseSummary; lessons: CourseLessonSummary[]; summary: AnalysisSummary }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

/** LIVE Whop provider-connection state — see courseApi.ts's getAuthStatus and SourcesPage.tsx's identical doc comment on why this is fetched independently of the course's own persisted data: a course/lessons/analyses persist in Postgres regardless of whether Whop happens to be connected right now. */
type ConnectionState = { connected: boolean; authRequired: boolean };
const INITIAL_CONNECTION: ConnectionState = { connected: false, authRequired: false };

/**
 * "/projects/:projectId/whop-courses/:courseId" — Phase 4K, rewritten in
 * the Phase 4K-D follow-up to be the SINGLE home for one Whop course's rich
 * management UI (dashboard stats, search/filters, bulk analyze actions,
 * lesson detail drawer, retry/re-analyze, pagination) — reusing
 * CourseTable/DashboardSummary UNCHANGED from the original single-course
 * experience (see CourseTable.tsx's own doc comment on what moved here vs.
 * what stayed on SourcesPage) rather than the simplified lesson list this
 * page used to render.
 *
 * Deliberately does NOT reuse App.tsx's old global `courseState` — that
 * was built around the pre-Phase-4K single-course assumption. Every fetch
 * here is keyed by THIS route's own `:courseId` param
 * (getWhopCourseDashboard), so opening course B can never show course A's
 * lessons/stats, and a project with any number of connected Whop courses
 * works identically for each one.
 *
 * IMPORT/CAPTURE/DISCOVER != ANALYZE: loading this page, and "Refresh
 * Course" (a metadata-only re-sync of the lesson catalog — see
 * pipeline/courseSync.ts), never starts analysis. Only the explicit
 * Select-and-Analyze / Analyze All Unanalyzed / Retry / Re-analyze actions
 * (all reusing courseApi.ts's existing, already-generic lessonId/jobId-
 * scoped endpoints — never course-scoped, never duplicated here) do.
 */
export function WhopCourseDetailPage({ backendUrl, knoveraToken }: WhopCourseDetailPageProps) {
  const navigate = useNavigate();
  const { courseId: courseIdParam } = useParams<{ courseId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const courseId = courseIdParam ? Number(courseIdParam) : NaN;

  async function loadDashboard(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const result = await getWhopCourseDashboard(url, token, projectId, courseId);
      if (!cancelledRef.current) setState({ phase: "loaded", course: result.course, lessons: result.lessons, summary: result.summary });
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof CatalogApiError && err.type === "course_not_found") {
        setState({ phase: "not_found" });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load course." });
      }
    }
  }

  async function loadConnection(url: string, token: string) {
    try {
      const status = await getAuthStatus(url, token);
      setConnection({ connected: status.connected, authRequired: status.status === "auth_required" });
    } catch {
      // Best-effort — a transient failure here only affects whether
      // Analyze/Retry/Re-analyze render enabled, never hides the lessons
      // themselves (which are read from Postgres regardless).
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(courseId)) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void loadDashboard(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    void loadConnection(backendUrl, knoveraToken);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) {
      void loadDashboard(backendUrl, knoveraToken, resolvedProjectId, { current: false });
      void loadConnection(backendUrl, knoveraToken);
    }
  }

  async function handleRefreshCourse() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setRefreshing(true);
    setActionError(null);
    try {
      await refreshWhopCourse(backendUrl, knoveraToken, resolvedProjectId, courseId);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh course.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleEnqueue(lessonIds: number[], force = false) {
    if (!backendUrl || !knoveraToken) return;
    setActionError(null);
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, lessonIds, force);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to queue analysis.");
    }
  }

  async function handleRetry(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    setActionError(null);
    try {
      await retryAnalysisJob(backendUrl, knoveraToken, jobId);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to retry job.");
    }
  }

  async function handleCancel(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    await cancelAnalysisJob(backendUrl, knoveraToken, jobId);
    refresh();
  }

  async function handleLoadAnalysis(lessonId: number): Promise<unknown | null> {
    if (!backendUrl || !knoveraToken) return null;
    return getLessonAnalysisJson(backendUrl, knoveraToken, lessonId);
  }

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading course…</p>}

      {state.phase === "not_found" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>This Whop course doesn't exist.</p>
          {resolvedProjectId != null && (
            <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
              ← Back to Sources
            </button>
          )}
        </div>
      )}

      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}

      {state.phase === "loaded" && (
        <>
          <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
            ← Sources
          </button>

          <div className="knovera-page-header">
            <div>
              <h2 className="knovera-section-title">{state.course.name}</h2>
              <p className="knovera-project-card-source">
                Whop Course · {state.lessons.length} lesson{state.lessons.length === 1 ? "" : "s"} · {state.course.analyzedLessonCount} analyzed
              </p>
            </div>
            <button type="button" disabled={refreshing} onClick={() => void handleRefreshCourse()}>
              {refreshing ? "Refreshing…" : "Refresh Course"}
            </button>
          </div>

          {actionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{actionError}</p>
            </div>
          )}

          <DashboardSummary summary={state.summary} />
          {state.course.lastSyncedAt && <p className="hint">Last synced: {new Date(state.course.lastSyncedAt).toLocaleString()}</p>}

          <CourseTable
            lessons={state.lessons}
            connected={connection.connected}
            authRequired={connection.authRequired}
            summary={state.summary}
            onSignIn={() => navigate(`/projects/${resolvedProjectId}/sources`)}
            onEnqueue={(lessonIds, force) => void handleEnqueue(lessonIds, force)}
            onRetry={(jobId) => void handleRetry(jobId)}
            onCancel={(jobId) => void handleCancel(jobId)}
            onLoadAnalysis={handleLoadAnalysis}
          />
        </>
      )}
    </div>
  );
}
