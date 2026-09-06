import { Fragment, useMemo, useState } from "react";
import { PROCESSING_STATUSES, type AnalysisSummary, type CourseLessonSummary, type LessonJobSummary } from "../lib/courseApi";
import { StatusBadge } from "./StatusBadge";
import { AnalysisDetailPanel } from "./AnalysisDetailPanel";

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
  /** Fetches the full validated JSON for one lesson's latest analysis, for the expandable detail view. */
  onLoadAnalysis: (lessonId: number) => Promise<unknown | null>;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

function formatCost(value: number | null | undefined): string {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
}

function formatProcessingTime(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** A processing job is "stale" if no heartbeat arrived recently — a display hint only, never an auto-fail. */
function isStale(job: LessonJobSummary): boolean {
  if (!PROCESSING_STATUSES.includes(job.status)) return false;
  if (!job.lastHeartbeatAt) return false;
  return Date.now() - new Date(job.lastHeartbeatAt).getTime() > 30_000;
}

function jobOf(lesson: CourseLessonSummary): LessonJobSummary {
  return lesson.job ?? { jobId: null, status: "NOT_ANALYZED" };
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy Link"}
    </button>
  );
}

interface PendingBatch {
  lessonIds: number[];
  force: boolean;
  label: string;
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
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedJson, setExpandedJson] = useState<unknown | null>(null);
  const [expandedLoading, setExpandedLoading] = useState(false);
  const [pendingBatch, setPendingBatch] = useState<PendingBatch | null>(null);

  const unanalyzedIds = useMemo(
    () => lessons.filter((l) => jobOf(l).status === "NOT_ANALYZED").map((l) => l.id),
    [lessons],
  );
  const failedIds = useMemo(
    () => lessons.filter((l) => jobOf(l).status === "FAILED").map((l) => l.id),
    [lessons],
  );

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
    setSelected(new Set(lessons.map((l) => l.id)));
  }
  function selectAllUnanalyzed() {
    setSelected(new Set(unanalyzedIds));
  }
  function selectFailed() {
    setSelected(new Set(failedIds));
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

  async function toggleExpand(lesson: CourseLessonSummary) {
    if (expandedId === lesson.id) {
      setExpandedId(null);
      setExpandedJson(null);
      return;
    }
    setExpandedId(lesson.id);
    setExpandedJson(null);
    setExpandedLoading(true);
    try {
      const json = await onLoadAnalysis(lesson.id);
      setExpandedJson(json);
    } finally {
      setExpandedLoading(false);
    }
  }

  function downloadJson(lesson: CourseLessonSummary) {
    if (expandedJson == null) return;
    const blob = new Blob([JSON.stringify(expandedJson, null, 2)], { type: "application/json" });
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

      {lessons.length === 0 ? (
        <p className="hint">No lessons synced yet — click "Sync Course" to discover them.</p>
      ) : (
        <>
          <div className="batch-toolbar">
            <div className="batch-selection-actions">
              <button className="link-button" onClick={selectAll}>
                Select All
              </button>
              <button className="link-button" onClick={selectAllUnanalyzed}>
                Select All Unanalyzed
              </button>
              <button className="link-button" onClick={selectFailed}>
                Select Failed
              </button>
              <button className="link-button" onClick={clearSelection}>
                Clear Selection
              </button>
            </div>
            <div className="batch-primary-actions">
              <button
                onClick={() => requestBatch(Array.from(selected), false, `${selected.size} selected lesson(s)`)}
                disabled={selected.size === 0}
              >
                Analyze Selected
              </button>
              <button
                onClick={() => requestBatch(unanalyzedIds, false, `${unanalyzedIds.length} unanalyzed lesson(s)`)}
                disabled={unanalyzedIds.length === 0}
              >
                Analyze All Unanalyzed
              </button>
              <button onClick={() => failedIds.forEach((id) => { const job = lessons.find((l) => l.id === id)?.job; if (job?.jobId) onRetry(job.jobId); })} disabled={failedIds.length === 0}>
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

          <div className="tablewrap">
            <table className="course-table">
              <thead>
                <tr>
                  <th>Select</th>
                  <th>#</th>
                  <th>Lesson</th>
                  <th className="hide-narrow">Chapter</th>
                  <th className="hide-narrow">Duration</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th className="hide-narrow">Strategy Found</th>
                  <th>Extracted Strategies</th>
                  <th className="hide-narrow">Rules</th>
                  <th className="hide-narrow">Confidence</th>
                  <th className="hide-narrow">Analysis Output</th>
                  <th className="hide-narrow">Cost</th>
                  <th className="hide-narrow">Processing Time</th>
                  <th className="hide-narrow">Last Analyzed</th>
                  <th className="hide-narrow">Source</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {lessons.map((lesson, i) => {
                  const job = jobOf(lesson);
                  const analysis = lesson.analysis ?? null;
                  const isProcessing = PROCESSING_STATUSES.includes(job.status);
                  const stale = isStale(job);

                  return (
                    <Fragment key={lesson.id}>
                      <tr>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(lesson.id)}
                            onChange={() => toggleOne(lesson.id)}
                            aria-label={`Select ${lesson.title}`}
                          />
                        </td>
                        <td>{i + 1}</td>
                        <td>{lesson.title}</td>
                        <td className="hide-narrow">{lesson.chapterTitle ?? "—"}</td>
                        <td className="hide-narrow">{formatDuration(lesson.durationSeconds)}</td>
                        <td>
                          <StatusBadge status={job.status} />
                          {stale && <span className="stale-hint"> (potentially stale)</span>}
                        </td>
                        <td>
                          {isProcessing ? (
                            <span>
                              {job.currentStage ?? job.status}
                              {job.stageProgress != null ? ` — ${job.stageProgress}%` : " — …"}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="hide-narrow">
                          {analysis == null ? "—" : analysis.strategyFound ? "Yes" : "No"}
                        </td>
                        <td>{analysis?.extractedStrategiesLabel ?? "—"}</td>
                        <td className="hide-narrow">
                          {analysis && analysis.ruleCounts.length > 0
                            ? analysis.ruleCounts.map((r) => `${r.label} ${r.count}`).join(", ")
                            : "—"}
                        </td>
                        <td className="hide-narrow">{formatConfidence(analysis?.confidence)}</td>
                        <td className="hide-narrow">{analysis?.summary ?? "—"}</td>
                        <td className="hide-narrow">{formatCost(analysis?.estimatedCost)}</td>
                        <td className="hide-narrow">{formatProcessingTime(analysis?.processingDurationSeconds)}</td>
                        <td className="hide-narrow">{formatDate(analysis?.completedAt)}</td>
                        <td className="hide-narrow">
                          <a href={lesson.sourceUrl} target="_blank" rel="noreferrer">
                            Open
                          </a>{" "}
                          <CopyLinkButton url={lesson.sourceUrl} />
                        </td>
                        <td>
                          <div className="row-actions">
                            {job.status === "NOT_ANALYZED" && (
                              <button className="link-button" onClick={() => requestBatch([lesson.id], false, lesson.title)}>
                                Analyze
                              </button>
                            )}
                            {job.status === "QUEUED" && job.jobId && (
                              <button className="link-button" onClick={() => onCancel(job.jobId!)}>
                                Cancel
                              </button>
                            )}
                            {(job.status === "FAILED" || job.status === "AUTH_REQUIRED") && job.jobId && (
                              <button className="link-button" onClick={() => onRetry(job.jobId!)}>
                                Retry
                              </button>
                            )}
                            {(job.status === "COMPLETED" || job.status === "NO_STRATEGY") && (
                              <>
                                <button className="link-button" onClick={() => void toggleExpand(lesson)}>
                                  {expandedId === lesson.id ? "Hide Analysis" : "View Analysis"}
                                </button>
                                <button className="link-button" onClick={() => requestBatch([lesson.id], true, lesson.title)}>
                                  Re-analyze
                                </button>
                              </>
                            )}
                            {job.sanitizedError && (
                              <span className="row-error" title={job.sanitizedError}>
                                View Error
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expandedId === lesson.id && (
                        <tr className="detail-row">
                          <td colSpan={17}>
                            <AnalysisDetailPanel
                              lesson={lesson}
                              validatedJson={expandedJson}
                              loading={expandedLoading}
                              onDownloadJson={() => downloadJson(lesson)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
