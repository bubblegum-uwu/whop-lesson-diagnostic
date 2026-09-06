import { useEffect, useMemo, useRef, useState } from "react";
import { PROCESSING_STATUSES, type AnalysisSummary, type CourseLessonSummary, type LessonJobSummary } from "../lib/courseApi";
import { StatusBadge } from "./StatusBadge";
import { LessonDetailDrawer } from "./LessonDetailDrawer";
import { RowActionsMenu } from "./RowActionsMenu";

export interface CourseTableProps {
  courseTitle: string | null;
  lessons: CourseLessonSummary[];
  connected: boolean;
  syncing: boolean;
  authRequired: boolean;
  lastSyncedAt: string | null;
  summary: AnalysisSummary | null;
  onSignIn: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  onEnqueue: (lessonIds: number[], force?: boolean) => void;
  onRetry: (jobId: string) => void;
  onCancel: (jobId: string) => void;
  /** Fetches the full validated JSON for one lesson's latest analysis, for the detail drawer. */
  onLoadAnalysis: (lessonId: number) => Promise<unknown | null>;
}

const NARROW_BREAKPOINT = 720;

/** Plain window.innerWidth + resize listener — no matchMedia polyfill needed, works the same in jsdom and real browsers. */
function useIsNarrow(breakpoint: number): boolean {
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    function onResize() {
      setIsNarrow(window.innerWidth < breakpoint);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isNarrow;
}

/** The backend reports raw pipeline stage keys (see backend STAGE_LABELS) — display-only friendly text, never sent back anywhere. */
const STAGE_DISPLAY_LABELS: Record<string, string> = {
  retrieving_lesson: "Retrieving",
  resolving_secure_video: "Retrieving",
  preparing_video: "Preparing",
  uploading_to_gemini: "Uploading",
  gemini_processing: "Processing on Gemini",
  analyzing_lesson: "Analyzing",
  validating_result: "Validating",
};

function friendlyStageLabel(currentStage: string | null | undefined, status: string): string {
  if (currentStage && STAGE_DISPLAY_LABELS[currentStage]) return STAGE_DISPLAY_LABELS[currentStage];
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

const PAGE_SIZES = [25, 50, 100];

const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "NOT_ANALYZED", label: "Not analyzed" },
  { value: "QUEUED", label: "Queued" },
  { value: "PROCESSING", label: "Processing" },
  { value: "COMPLETED", label: "Completed" },
  { value: "NO_STRATEGY", label: "No standalone setup" },
  { value: "FAILED", label: "Failed" },
  { value: "AUTH_REQUIRED", label: "Auth required" },
  { value: "CANCELLED", label: "Cancelled" },
];

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function formatCost(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

/** Compact "ANALYZED" cell text, e.g. "Sep 6, 2026, 8:31 AM" — the full timestamp is available via the cell's `title` attribute on hover. This is `analysis?.completedAt` — the latest SUCCESSFUL analysis's completion time, deliberately distinct from `lastSyncedAt` (when the lesson's metadata was last pulled from Whop). It does not change while a re-analysis job is QUEUED/PROCESSING/etc: `analysis` and `job` are independently sourced, so the previous successful timestamp keeps showing until a new analysis actually completes and lands as the new `analysis`. */
function formatAnalyzedCompact(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatAnalyzedFull(value: string | null | undefined): string {
  if (!value) return "Not yet analyzed";
  return new Date(value).toLocaleString();
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.max(0, Math.round(totalSeconds % 60));
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "Break & Retest" | "3 strategies" | "No standalone setup" | "—" — never the long summary (that lives in the drawer). */
function resultLabel(analysis: CourseLessonSummary["analysis"]): string {
  if (!analysis) return "—";
  if (!analysis.strategyFound) return "No standalone setup";
  const match = analysis.extractedStrategiesLabel?.match(/\+(\d+) more$/);
  if (match) return `${1 + Number(match[1])} strategies`;
  return analysis.extractedStrategiesLabel ?? "Strategy found";
}

export type HeartbeatLevel = "normal" | "waiting" | "no_heartbeat" | "recovery";

export interface HeartbeatState {
  level: HeartbeatLevel;
  /** null renders nothing — the normal, healthy case. */
  label: string | null;
}

const NO_HEARTBEAT_STATE: HeartbeatState = { level: "normal", label: null };

/**
 * A display hint only — never an auto-fail, and never implies the job has
 * failed. A long Gemini call (uploading/processing/analyzing) can go
 * minutes between heartbeats even while perfectly healthy, so this reads as
 * increasingly cautious language rather than an alarm:
 *   < 30s heartbeat age            -> normal (nothing shown)
 *   30s–90s                        -> soft "Waiting for update"
 *   > 90s (job still non-terminal) -> "No recent worker heartbeat"
 *   lease_expires_at has actually
 *   passed (worker likely dead)    -> stronger "Waiting for recovery"
 * A genuinely expired lease is a stronger signal than heartbeat age alone
 * (the Scheduler safety net will reclaim it), so it takes priority.
 */
function heartbeatState(job: LessonJobSummary): HeartbeatState {
  if (!PROCESSING_STATUSES.includes(job.status)) return NO_HEARTBEAT_STATE;

  if (job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() < Date.now()) {
    return { level: "recovery", label: "Waiting for recovery" };
  }

  if (!job.lastHeartbeatAt) return NO_HEARTBEAT_STATE;
  const heartbeatAgeMs = Date.now() - new Date(job.lastHeartbeatAt).getTime();
  if (heartbeatAgeMs > 90_000) return { level: "no_heartbeat", label: "No recent worker heartbeat" };
  if (heartbeatAgeMs > 30_000) return { level: "waiting", label: "Waiting for update" };
  return NO_HEARTBEAT_STATE;
}

function jobOf(lesson: CourseLessonSummary): LessonJobSummary {
  return lesson.job ?? { jobId: null, status: "NOT_ANALYZED" };
}

interface StageSince {
  stage: string;
  since: number;
}

/** Renders live "elapsed" / "elapsed / total" text for an in-progress lesson, from already-available data only. */
function useProgressText() {
  const sinceMap = useRef(new Map<number, StageSince>());
  const [, setTick] = useState(0);

  function noteStage(lessonId: number, job: LessonJobSummary) {
    const stageKey = `${job.status}:${job.currentStage ?? ""}`;
    const existing = sinceMap.current.get(lessonId);
    if (!existing || existing.stage !== stageKey) {
      sinceMap.current.set(lessonId, { stage: stageKey, since: Date.now() });
    }
  }

  function progressText(lesson: CourseLessonSummary, job: LessonJobSummary): string {
    if (!PROCESSING_STATUSES.includes(job.status)) return "—";
    noteStage(lesson.id, job);
    const label = friendlyStageLabel(job.currentStage, job.status);

    if (job.stageProgress != null && lesson.durationSeconds) {
      const elapsed = Math.round((job.stageProgress / 100) * lesson.durationSeconds);
      return `${label}\n${formatClock(elapsed)} / ${formatClock(lesson.durationSeconds)}`;
    }

    const since = sinceMap.current.get(lesson.id)?.since;
    if (since) {
      const elapsedSeconds = Math.floor((Date.now() - since) / 1000);
      return `${label}\n${formatClock(elapsedSeconds)} elapsed`;
    }
    return label;
  }

  return { progressText, tickRef: setTick };
}

interface PendingBatch {
  lessonIds: number[];
  force: boolean;
  label: string;
}

interface RowActionsProps {
  lesson: CourseLessonSummary;
  job: LessonJobSummary;
  onView: () => void;
  onAnalyze: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onReanalyze: () => void;
  onDownload: () => void;
}

function RowActions({ lesson, job, onView, onAnalyze, onRetry, onCancel, onReanalyze, onDownload }: RowActionsProps) {
  const hasAnalysis = job.status === "COMPLETED" || job.status === "NO_STRATEGY";
  const menuItems = [
    { label: "Open Source", onClick: () => window.open(lesson.sourceUrl, "_blank", "noreferrer") },
    { label: "Download JSON", onClick: onDownload, disabled: !hasAnalysis },
    { label: "Re-analyze", onClick: onReanalyze, disabled: !hasAnalysis },
  ];

  return (
    <div className="row-actions">
      {job.status === "NOT_ANALYZED" && (
        <button className="link-button" onClick={onAnalyze}>
          Analyze
        </button>
      )}
      {job.status === "QUEUED" && (
        <button className="link-button" onClick={onCancel}>
          Cancel
        </button>
      )}
      {(job.status === "FAILED" || job.status === "AUTH_REQUIRED") && (
        <button className="link-button" onClick={onRetry}>
          Retry
        </button>
      )}
      {(job.status === "COMPLETED" || job.status === "NO_STRATEGY") && (
        <button className="link-button" onClick={onView}>
          View
        </button>
      )}
      {job.sanitizedError && (
        <span className="row-error" title={job.sanitizedError}>
          ⚠
        </span>
      )}
      <RowActionsMenu items={menuItems} />
    </div>
  );
}

export function CourseTable({
  courseTitle,
  lessons,
  connected,
  syncing,
  authRequired,
  lastSyncedAt,
  summary,
  onSignIn,
  onSync,
  onDisconnect,
  onEnqueue,
  onRetry,
  onCancel,
  onLoadAnalysis,
}: CourseTableProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [drawerLessonId, setDrawerLessonId] = useState<number | null>(null);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [chapterFilter, setChapterFilter] = useState("ALL");
  const [strategyFilter, setStrategyFilter] = useState("ALL");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [analyzedSort, setAnalyzedSort] = useState<"asc" | "desc" | null>(null);
  const { progressText, tickRef } = useProgressText();
  const isNarrow = useIsNarrow(NARROW_BREAKPOINT);

  const anyProcessing = useMemo(() => lessons.some((l) => PROCESSING_STATUSES.includes(jobOf(l).status)), [lessons]);
  useEffect(() => {
    if (!anyProcessing) return undefined;
    const interval = setInterval(() => tickRef((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [anyProcessing, tickRef]);

  const chapters = useMemo(
    () => Array.from(new Set(lessons.map((l) => l.chapterTitle).filter((c): c is string => !!c))),
    [lessons],
  );

  const filteredLessons = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return lessons.filter((lesson) => {
      const job = jobOf(lesson);
      if (searchLower && !lesson.title.toLowerCase().includes(searchLower)) return false;
      if (statusFilter === "PROCESSING") {
        if (!PROCESSING_STATUSES.includes(job.status)) return false;
      } else if (statusFilter !== "ALL" && job.status !== statusFilter) {
        return false;
      }
      if (chapterFilter !== "ALL" && lesson.chapterTitle !== chapterFilter) return false;
      if (strategyFilter === "FOUND" && lesson.analysis?.strategyFound !== true) return false;
      if (strategyFilter === "NOT_FOUND" && !(lesson.analysis && lesson.analysis.strategyFound === false)) return false;
      return true;
    });
  }, [lessons, search, statusFilter, chapterFilter, strategyFilter]);

  // Lessons never analyzed (null completedAt) always sort to the end,
  // regardless of direction — there's no meaningful position for "never" in
  // either an ascending or descending date order.
  const sortedLessons = useMemo(() => {
    if (!analyzedSort) return filteredLessons;
    const withTime = filteredLessons.map((lesson) => ({
      lesson,
      time: lesson.analysis?.completedAt ? new Date(lesson.analysis.completedAt).getTime() : null,
    }));
    withTime.sort((a, b) => {
      if (a.time == null && b.time == null) return 0;
      if (a.time == null) return 1;
      if (b.time == null) return -1;
      return analyzedSort === "asc" ? a.time - b.time : b.time - a.time;
    });
    return withTime.map((w) => w.lesson);
  }, [filteredLessons, analyzedSort]);

  const totalPages = Math.max(1, Math.ceil(sortedLessons.length / pageSize));
  // Derived, not effect-driven: if filtering/page-size shrank the result set
  // out from under the current page, clamp it during render instead of
  // firing a setState-in-effect just to reset it.
  const currentPage = Math.min(page, totalPages);
  const pagedLessons = sortedLessons.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function toggleAnalyzedSort() {
    setAnalyzedSort((prev) => (prev === "desc" ? "asc" : "desc"));
  }

  const unanalyzedIds = useMemo(
    () => filteredLessons.filter((l) => jobOf(l).status === "NOT_ANALYZED").map((l) => l.id),
    [filteredLessons],
  );
  const failedIds = useMemo(
    () => filteredLessons.filter((l) => jobOf(l).status === "FAILED").map((l) => l.id),
    [filteredLessons],
  );

  const drawerLesson = drawerLessonId == null ? null : lessons.find((l) => l.id === drawerLessonId) ?? null;

  if (!connected) {
    return (
      <div className="course-section">
        <h2>Scarface Trades Mastermind</h2>
        {authRequired ? (
          <div className="error-panel" role="alert">
            <p>Whop authorization expired. Reconnect to resume course sync.</p>
          </div>
        ) : (
          <p className="hint">Connect Whop to discover every lesson in this course.</p>
        )}
        <button onClick={onSignIn}>Connect Whop</button>
      </div>
    );
  }

  function toggleOne(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filteredLessons.map((l) => l.id)));
  }
  function selectAllUnanalyzed() {
    setSelected(new Set(unanalyzedIds));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  function knownDurationSummary(ids: number[]): string {
    const known = lessons.filter((l) => ids.includes(l.id) && l.durationSeconds != null);
    if (known.length === 0) return "unknown";
    const totalSeconds = known.reduce((sum, l) => sum + (l.durationSeconds ?? 0), 0);
    const minutes = Math.round(totalSeconds / 60);
    return known.length === ids.length ? `${minutes}m` : `${minutes}m (${ids.length - known.length} unknown)`;
  }

  function estimatedCostSummary(ids: number[]): string {
    if (!summary?.averageCostPerLesson) return "unknown (no historical data yet)";
    return `~$${(summary.averageCostPerLesson * ids.length).toFixed(2)} (based on this course's average)`;
  }

  function requestBatch(lessonIds: number[], force: boolean, label: string) {
    if (lessonIds.length === 0) return;
    setPendingBatch({ lessonIds, force, label });
  }

  function confirmBatch() {
    if (!pendingBatch) return;
    onEnqueue(pendingBatch.lessonIds, pendingBatch.force);
    setPendingBatch(null);
    clearSelection();
  }

  function retryAllFailed() {
    for (const id of failedIds) {
      const jobId = lessons.find((l) => l.id === id)?.job?.jobId;
      if (jobId) onRetry(jobId);
    }
  }

  async function handleDownload(lesson: CourseLessonSummary) {
    const json = await onLoadAnalysis(lesson.id);
    if (json == null) return;
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${lesson.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-analysis.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="course-section">
      <div className="course-header">
        <h2>{courseTitle ?? "Scarface Trades Mastermind"}</h2>
        <div className="course-actions">
          <button onClick={onSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync Course"}
          </button>
          <button onClick={onDisconnect} className="link-button">
            Disconnect Whop
          </button>
        </div>
      </div>
      {lastSyncedAt && <p className="hint">Last synced: {new Date(lastSyncedAt).toLocaleString()}</p>}

      {/* Flex row, not an overlay: when the drawer is open it's a real sibling
          with its own fixed width, so .course-main (flex: 1 1 auto, min-width: 0)
          shrinks to make room instead of the drawer floating on top of columns
          the reader still needs (see .col-result/.hide-narrow container-query
          rules in index.css, which react to this shrunken width). */}
      <div className="course-layout">
        <div className="course-main">
      {lessons.length === 0 ? (
        <p className="hint">No lessons synced yet — click "Sync Course" to discover them.</p>
      ) : (
        <>
          <div className="course-toolbar">
            <div className="toolbar-filters">
              <input
                type="search"
                className="toolbar-search"
                placeholder="Search lessons…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search lessons"
              />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
                {STATUS_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <select value={chapterFilter} onChange={(e) => setChapterFilter(e.target.value)} aria-label="Filter by chapter">
                <option value="ALL">All chapters</option>
                {chapters.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)} aria-label="Filter by strategy found">
                <option value="ALL">Strategy: all</option>
                <option value="FOUND">Strategy found</option>
                <option value="NOT_FOUND">No standalone setup</option>
              </select>
            </div>

            <div className="toolbar-selection-actions">
              <button className="link-button" onClick={selectAllUnanalyzed}>
                Select All Unanalyzed
              </button>
              <button className="link-button" onClick={clearSelection}>
                Clear Selection
              </button>
            </div>

            <div className="toolbar-primary-actions">
              <button
                onClick={() => requestBatch(Array.from(selected), false, `${selected.size} selected lesson(s)`)}
                disabled={selected.size === 0}
              >
                Analyze Selected{selected.size > 0 ? ` (${selected.size} selected)` : ""}
              </button>
              <button
                onClick={() => requestBatch(unanalyzedIds, false, `${unanalyzedIds.length} unanalyzed lesson(s)`)}
                disabled={unanalyzedIds.length === 0}
              >
                Analyze All Unanalyzed
              </button>
              <button onClick={retryAllFailed} disabled={failedIds.length === 0}>
                Retry Failed
              </button>
            </div>
          </div>

          {pendingBatch && (
            <div className="batch-confirm" role="alertdialog">
              <p>
                <strong>{pendingBatch.lessonIds.length}</strong> lesson(s) selected.
              </p>
              <p>Total known video duration: {knownDurationSummary(pendingBatch.lessonIds)}</p>
              <p>Estimated cost: {estimatedCostSummary(pendingBatch.lessonIds)}</p>
              <div className="batch-confirm-actions">
                <button onClick={confirmBatch}>Confirm</button>
                <button className="link-button" onClick={() => setPendingBatch(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {filteredLessons.length === 0 ? (
            <p className="hint">No lessons match the current search/filters.</p>
          ) : (
            <>
              {isNarrow ? (
                <div className="lesson-cards">
                  {pagedLessons.map((lesson) => {
                    const job = jobOf(lesson);
                    const analysis = lesson.analysis ?? null;
                    const progress = progressText(lesson, job);
                    const [progressLabel, progressDetail] = progress.split("\n");

                    return (
                      <div className="lesson-card" key={lesson.id}>
                        <div className="lesson-card-top">
                          <input
                            type="checkbox"
                            checked={selected.has(lesson.id)}
                            onChange={() => toggleOne(lesson.id)}
                            aria-label={`Select ${lesson.title}`}
                          />
                          <span className="lesson-card-title">{lesson.title}</span>
                        </div>
                        <div className="lesson-card-meta">
                          <StatusBadge status={job.status} />
                          <span>{resultLabel(analysis)}</span>
                          {analysis?.completedAt && (
                            <span title={formatAnalyzedFull(analysis.completedAt)}>Analyzed {formatAnalyzedCompact(analysis.completedAt)}</span>
                          )}
                        </div>
                        {progressDetail && (
                          <div className="lesson-card-progress">
                            {progressLabel} — {progressDetail}
                          </div>
                        )}
                        <RowActions
                          lesson={lesson}
                          job={job}
                          onView={() => setDrawerLessonId(lesson.id)}
                          onAnalyze={() => requestBatch([lesson.id], false, lesson.title)}
                          onRetry={() => job.jobId && onRetry(job.jobId)}
                          onCancel={() => job.jobId && onCancel(job.jobId)}
                          onReanalyze={() => requestBatch([lesson.id], true, lesson.title)}
                          onDownload={() => void handleDownload(lesson)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="table-scroll-area">
                  <table className="course-table">
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Select all filtered lessons"
                            checked={filteredLessons.length > 0 && filteredLessons.every((l) => selected.has(l.id))}
                            onChange={(e) => (e.target.checked ? selectAll() : clearSelection())}
                          />
                        </th>
                        <th className="hide-narrow">#</th>
                        <th className="col-lesson">Lesson</th>
                        <th className="hide-narrow">Chapter</th>
                        <th className="hide-narrow">Duration</th>
                        <th>Status</th>
                        <th>Progress</th>
                        <th>Result</th>
                        <th className="hide-narrow col-analyzed">
                          <button type="button" className="col-sort-button" onClick={toggleAnalyzedSort} aria-label="Sort by analyzed date">
                            Analyzed{analyzedSort === "asc" ? " ▲" : analyzedSort === "desc" ? " ▼" : ""}
                          </button>
                        </th>
                        <th className="hide-narrow">Cost</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedLessons.map((lesson, i) => {
                        const job = jobOf(lesson);
                        const analysis = lesson.analysis ?? null;
                        const heartbeat = heartbeatState(job);
                        const progress = progressText(lesson, job);
                        const [progressLabel, progressDetail] = progress.split("\n");
                        const result = resultLabel(analysis);
                        const resultTitle = (analysis?.strategyFound ? analysis.extractedStrategiesLabel : null) ?? result;

                        return (
                          <tr key={lesson.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selected.has(lesson.id)}
                                onChange={() => toggleOne(lesson.id)}
                                aria-label={`Select ${lesson.title}`}
                              />
                            </td>
                            <td className="hide-narrow">{(currentPage - 1) * pageSize + i + 1}</td>
                            <td className="col-lesson" title={lesson.title}>
                              <span className="clamp-2-lines">{lesson.title}</span>
                            </td>
                            <td className="hide-narrow col-chapter">
                              <span className="clamp-2-lines">{lesson.chapterTitle ?? "—"}</span>
                            </td>
                            <td className="hide-narrow">{formatDuration(lesson.durationSeconds)}</td>
                            <td>
                              <StatusBadge status={job.status} />
                              {heartbeat.label && <span className={`heartbeat-hint heartbeat-${heartbeat.level}`}> {heartbeat.label}</span>}
                            </td>
                            <td>
                              {progressDetail ? (
                                <span className="progress-cell">
                                  <span className="progress-stage">{progressLabel}</span>
                                  <span className="progress-detail">{progressDetail}</span>
                                </span>
                              ) : (
                                progressLabel
                              )}
                            </td>
                            <td className="col-result" title={resultTitle}>
                              <span className="clamp-2-lines">{result}</span>
                            </td>
                            <td className="hide-narrow col-analyzed" title={formatAnalyzedFull(analysis?.completedAt)}>
                              {formatAnalyzedCompact(analysis?.completedAt)}
                            </td>
                            <td className="hide-narrow">{formatCost(analysis?.estimatedCost)}</td>
                            <td>
                              <RowActions
                                lesson={lesson}
                                job={job}
                                onView={() => setDrawerLessonId(lesson.id)}
                                onAnalyze={() => requestBatch([lesson.id], false, lesson.title)}
                                onRetry={() => job.jobId && onRetry(job.jobId)}
                                onCancel={() => job.jobId && onCancel(job.jobId)}
                                onReanalyze={() => requestBatch([lesson.id], true, lesson.title)}
                                onDownload={() => void handleDownload(lesson)}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="pagination-bar">
                <label>
                  Page size:{" "}
                  <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="pagination-controls">
                  <button className="link-button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
                    Previous
                  </button>
                  <span>
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    className="link-button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
        </div>
        <LessonDetailDrawer lesson={drawerLesson} onClose={() => setDrawerLessonId(null)} onLoadAnalysis={onLoadAnalysis} />
      </div>
    </div>
  );
}
