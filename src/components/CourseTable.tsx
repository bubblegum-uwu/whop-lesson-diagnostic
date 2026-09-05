import { useState } from "react";
import type { CourseLessonSummary } from "../lib/courseApi";

export interface CourseTableProps {
  courseTitle: string | null;
  lessons: CourseLessonSummary[];
  connected: boolean;
  syncing: boolean;
  authRequired: boolean;
  lastSyncedAt: string | null;
  onSignIn: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  /** Hands off to the existing, unmodified single-lesson analysis flow. */
  onAnalyzeLesson: (sourceUrl: string) => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
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

export function CourseTable({
  courseTitle,
  lessons,
  connected,
  syncing,
  authRequired,
  lastSyncedAt,
  onSignIn,
  onSync,
  onDisconnect,
  onAnalyzeLesson,
}: CourseTableProps) {
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
        <div className="tablewrap">
          <table className="course-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Lesson</th>
                <th>Chapter</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {lessons.map((lesson, i) => (
                <tr key={lesson.id}>
                  <td>{i + 1}</td>
                  <td>{lesson.title}</td>
                  <td>{lesson.chapterTitle ?? "—"}</td>
                  <td>{formatDuration(lesson.durationSeconds)}</td>
                  <td>
                    <a href={lesson.sourceUrl} target="_blank" rel="noreferrer">
                      Open
                    </a>{" "}
                    <CopyLinkButton url={lesson.sourceUrl} />
                  </td>
                  <td>Not analyzed</td>
                  <td>
                    <button onClick={() => onAnalyzeLesson(lesson.sourceUrl)}>Analyze</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
