import { useEffect, useState } from "react";
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

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const [dashboard, authStatus] = await Promise.all([getWhopCourseDashboard(url, token, projectId, courseId), getAuthStatus(url, token)]);
      if (cancelledRef.current) return;
      setState({ phase: "loaded", course: dashboard.course, summary: dashboard.summary, lessons: dashboard.lessons });
      setConnected(authStatus.connected);
      setAuthRequired(authStatus.status === "auth_required");
    } catch (err) {
      if (cancelledRef.current) return;
      if (err instanceof CatalogApiError && err.type === "course_not_found") {
        setState({ phase: "not_found" });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load course." });
      }
    }
  }

  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(courseId)) {
      setState({ phase: "idle" });
      return;
    }
    // Reset synchronously — a courseId change (Course A -> Course B) must
    // never keep showing Course A's lessons while Course B's fetch is in
    // flight.
    setState({ phase: "loading" });
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  // Live-notification layer, scoped to this page's own courseId: on any
  // analysis event, reload THIS course's dashboard — mirrors the app's
  // former global refresh, but never leaks into a course the operator
  // isn't currently viewing (a stale event simply causes an extra,
  // harmless refetch of this course's own already-scoped endpoint).
  useEffect(() => {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null || !Number.isInteger(courseId)) return undefined;
    const url = backendUrl;
    const token = knoveraToken;
    const projectId = resolvedProjectId;
    const unsubscribe = subscribeAnalysisEvents(url, token, () => {
      void load(url, token, projectId, { current: false });
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
  }

  function goToSources() {
    navigate(`/projects/${resolvedProjectId}/sources`);
  }

  async function handleRefreshCourse() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setSyncing(true);
    setActionError(null);
    try {
      await refreshWhopCourse(backendUrl, knoveraToken, resolvedProjectId, courseId);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh course.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleEnqueue(lessonIds: number[], force = false) {
    if (!backendUrl || !knoveraToken) return;
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, lessonIds, force);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to queue analysis.");
    }
  }

  async function handleRetry(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
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
