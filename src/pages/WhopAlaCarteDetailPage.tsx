import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ProjectHeader } from "./ProjectHeader";
import { useResolvedProject } from "../lib/useResolvedProject";
import { listAlaCarteWhopLessons, type AlaCarteWhopLessonSummary } from "../lib/catalogApi";
import { enqueueAnalysisJobs } from "../lib/courseApi";

export interface WhopAlaCarteDetailPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

/** Phase 4K follow-up — à-la-carte Whop lessons use the lesson-analysis job's own status vocabulary (see WhopCourseDetailPage's identical STATUS_LABELS/PENDING_STATUSES), a different set of states than project_source-based analysis. */
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

type LoadState = { phase: "idle" } | { phase: "loading" } | { phase: "loaded"; lessons: AlaCarteWhopLessonSummary[] } | { phase: "error"; message: string };

/**
 * "/projects/:projectId/whop-ala-carte" — Phase 4L taxonomy correction. The
 * WHOP · À-LA-CARTE group's detail page: individually-imported Whop lessons
 * (never a full course — see whopLessonImportsRepo.ts's doc comment).
 * Whop lessons live in the `lessons` table, never `project_sources` — they
 * are structurally outside Synthesis Set scope (which requires a real
 * project_sources row), so unlike CollectionDetailPage this page has no
 * checkbox/tri-state selection UI, only the same per-lesson
 * Analyze/Retry/Re-analyze controls WhopCourseDetailPage already uses.
 */
export function WhopAlaCarteDetailPage({ backendUrl, knoveraToken }: WhopAlaCarteDetailPageProps) {
  const navigate = useNavigate();
  const { state: projectState } = useResolvedProject(backendUrl, knoveraToken);
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resolvedProjectId = projectState.phase === "resolved" ? projectState.project.id : null;

  async function load(url: string, token: string, projectId: number, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const lessons = await listAlaCarteWhopLessons(url, token, projectId);
      if (!cancelledRef.current) setState({ phase: "loaded", lessons });
    } catch (err) {
      if (!cancelledRef.current) setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load lessons." });
    }
  }

  useEffect(() => {
    if (projectState.phase !== "resolved" || !backendUrl || !knoveraToken) {
      setState({ phase: "idle" });
      return;
    }
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, projectState.project.id, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectState, backendUrl, knoveraToken]);

  function refresh() {
    if (backendUrl && knoveraToken && resolvedProjectId != null) void load(backendUrl, knoveraToken, resolvedProjectId, { current: false });
  }

  async function handleAnalyze(lessonId: number, force = false) {
    if (!backendUrl || !knoveraToken) return;
    setBusyId(lessonId);
    setActionError(null);
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, [lessonId], force);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to start analysis.");
    } finally {
      setBusyId(null);
    }
  }

  const lessons = state.phase === "loaded" ? state.lessons : [];

  return (
    <div className="knovera-page">
      <ProjectHeader backendUrl={backendUrl} knoveraToken={knoveraToken} />

      <button type="button" className="link-button" onClick={() => navigate(`/projects/${resolvedProjectId}/sources`)}>
        ← Sources
      </button>

      <div className="knovera-page-header">
        <div>
          <h2 className="knovera-section-title">WHOP · À-LA-CARTE</h2>
          <p className="knovera-project-card-source">Individually imported lessons — never a full course. Connect the course instead to see all of its lessons.</p>
        </div>
      </div>

      {state.phase === "loading" && <p className="knovera-sources-loading">Loading lessons…</p>}
      {state.phase === "error" && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{state.message}</p>
        </div>
      )}
      {state.phase === "loaded" && lessons.length === 0 && (
        <div className="kv-card knovera-empty-state">
          <p>No à-la-carte Whop lessons.</p>
        </div>
      )}
      {actionError && (
        <div className="kv-card knovera-empty-state" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {lessons.length > 0 && (
        <ul className="knovera-youtube-source-list">
          {lessons.map((lesson) => {
            const isPending = WHOP_LESSON_PENDING_STATUSES.has(lesson.status);
            const isFailed = lesson.status === "FAILED";
            const isDone = lesson.status === "ANALYZED";
            const badgeClass = isFailed ? "kv-badge-danger" : isDone ? "kv-badge-accent" : "kv-badge-muted";
            const busy = busyId === lesson.id;
            return (
              <li key={lesson.id} className="kv-card knovera-youtube-source-row">
                <div className="knovera-youtube-source-main">
                  <span className="knovera-youtube-source-label">{lesson.courseTitle}</span>
                  <span className="knovera-youtube-source-title">{lesson.title}</span>
                </div>
                <div className="knovera-youtube-source-actions">
                  <span className={`kv-badge ${badgeClass}`}>{WHOP_LESSON_STATUS_LABELS[lesson.status] ?? lesson.status}</span>
                  {lesson.status === "NOT_ANALYZED" && (
                    <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(lesson.id)}>
                      {busy ? "Starting…" : "Analyze"}
                    </button>
                  )}
                  {isPending && <span className="hint">Working…</span>}
                  {isFailed && (
                    <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(lesson.id)}>
                      {busy ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  {isDone && (
                    <button type="button" className="link-button" disabled={busy} onClick={() => void handleAnalyze(lesson.id, true)}>
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
      )}
    </div>
  );
}
