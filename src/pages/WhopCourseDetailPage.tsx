import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { useResolvedProject } from "../lib/useResolvedProject";
import { listWhopCourseLessons, refreshWhopCourse, CatalogApiError, type WhopCourseSummary, type WhopLessonItemSummary } from "../lib/catalogApi";
import { enqueueAnalysisJobs } from "../lib/courseApi";

export interface WhopCourseDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; course: WhopCourseSummary; items: WhopLessonItemSummary[] }
  | { phase: "not_found" }
  | { phase: "error"; message: string };

const STATUS_LABELS: Record<string, string> = {
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
const PENDING_STATUSES = new Set(["QUEUED", "ANALYZING", "RETRIEVING", "PREPARING_VIDEO", "UPLOADING", "VALIDATING"]);

/**
 * "/projects/:projectId/whop-courses/:courseId" — Phase 4K. A Whop
 * course's lessons: checkbox selection + explicit batch enqueue (reusing
 * enqueueAnalysisJobs — the SAME lesson-analysis job machinery the
 * original single-course CourseTable already uses, unchanged), individual
 * Analyze/Retry per lesson. Deliberately does not reuse LessonDetailDrawer
 * here (that component expects the fuller CourseLessonSummary shape this
 * lightweight catalog list intentionally doesn't fetch — see
 * whopCourses.ts's doc comment on why this list stays summary-only);
 * "View" opens the lesson directly on Whop instead.
 */
export function WhopCourseDetailPage({ backendUrl, knoveraToken }: WhopCourseDetailPageProps) {
  const navigate = useNavigate();
  const { courseId: courseIdParam } = useParams<{ courseId: string }>();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;
  const courseId = courseIdParam ? Number(courseIdParam) : NaN;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const result = await listWhopCourseLessons(url, token, projectId, courseId, { limit: 200 });
      if (!cancelledRef.current) setState({ phase: "loaded", course: result.course, items: result.items });
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
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, resolvedProjectId, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, resolvedProjectId, courseId]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllUnanalyzed() {
    if (state.phase !== "loaded") return;
    setSelected(new Set(state.items.filter((i) => i.status === "NOT_ANALYZED" || i.status === "FAILED").map((i) => i.id)));
  }

  async function handleAnalyzeSelected() {
    if (!backendUrl || !knoveraToken || selected.size === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, [...selected]);
      setSelected(new Set());
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start analysis.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAnalyzeOne(lessonId: number, force = false) {
    if (!backendUrl || !knoveraToken) return;
    setBusy(true);
    setActionError(null);
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, [lessonId], force);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start analysis.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshCourse() {
    if (!backendUrl || !knoveraToken || resolvedProjectId == null) return;
    setBusy(true);
    setActionError(null);
    try {
      await refreshWhopCourse(backendUrl, knoveraToken, resolvedProjectId, courseId);
      refresh();
    } catch (err) {
      setActionError(err instanceof CatalogApiError ? err.message : "Failed to refresh course.");
    } finally {
      setBusy(false);
    }
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
                Whop Course · {state.items.length} lesson{state.items.length === 1 ? "" : "s"} · {state.course.analyzedLessonCount} analyzed
              </p>
            </div>
            <button type="button" className="link-button" disabled={busy} onClick={() => void handleRefreshCourse()}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {actionError && (
            <div className="kv-card knovera-empty-state" role="alert">
              <p>{actionError}</p>
            </div>
          )}

          <div className="knovera-synthesis-set-detail-actions">
            <button type="button" className="link-button" onClick={selectAllUnanalyzed}>
              Select All Unanalyzed
            </button>
            <button type="button" disabled={busy || selected.size === 0} onClick={() => void handleAnalyzeSelected()}>
              {busy ? "Starting…" : `Analyze Selected (${selected.size})`}
            </button>
          </div>

          <ul className="knovera-youtube-source-list">
            {state.items.map((item) => {
              const isPending = PENDING_STATUSES.has(item.status);
              const isFailed = item.status === "FAILED";
              const isDone = item.status === "ANALYZED";
              const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";
              return (
                <li key={item.id} className="kv-card knovera-youtube-source-row">
                  <label className="knovera-synthesis-set-source-checkbox">
                    <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Select ${item.title}`} />
                    <div className="knovera-youtube-source-main">
                      {item.chapterTitle && <span className="knovera-youtube-source-label">{item.chapterTitle}</span>}
                      <span className="knovera-youtube-source-title">{item.title}</span>
                    </div>
                  </label>
                  <div className="knovera-youtube-source-actions">
                    <span className={`kv-badge ${badgeClass}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
                    {item.status === "NOT_ANALYZED" && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id)}>
                        Analyze
                      </button>
                    )}
                    {isPending && <span className="hint">Working…</span>}
                    {isFailed && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id)}>
                        Retry
                      </button>
                    )}
                    {isDone && (
                      <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyzeOne(item.id, true)}>
                        Re-analyze
                      </button>
                    )}
                    <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="link-button">
                      Open on Whop
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
