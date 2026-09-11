import { useState, type FormEvent } from "react";
import { connectWhopCourse, CatalogApiError } from "../lib/catalogApi";

export interface ConnectWhopCourseDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  onClose: () => void;
  onConnected: () => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4K — connects an ADDITIONAL Whop course to this project (a
 * project may now own any number of courses). Discovers the course's
 * lesson catalog without analyzing any lesson. Uses the operator's
 * already-established Whop session — never prompts for a new OAuth flow.
 */
export function ConnectWhopCourseDialog({ backendUrl, knoveraToken, projectId, onClose, onConnected }: ConnectWhopCourseDialogProps) {
  const [courseUrl, setCourseUrl] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const submitting = state.phase === "submitting";
  const trimmed = courseUrl.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || trimmed.length === 0) return;
    setState({ phase: "submitting" });
    try {
      await connectWhopCourse(backendUrl, knoveraToken, projectId, trimmed);
      onConnected();
    } catch (err) {
      setState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to connect this Whop course. Please try again." });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-whop-course-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="connect-whop-course-title">Connect Whop Course</h2>
        <p className="knovera-dialog-subtitle">Discovers the course's lessons without analyzing any of them.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="whop-course-url">Whop Course URL</label>
          <input
            id="whop-course-url"
            type="text"
            placeholder="https://whop.com/{company}/{experience}/app/courses/{course_id}/"
            value={courseUrl}
            onChange={(e) => setCourseUrl(e.target.value)}
            disabled={submitting}
            autoFocus
            autoComplete="off"
          />
          {state.phase === "error" && (
            <p className="knovera-field-error" role="alert">
              {state.message}
            </p>
          )}
          <div className="knovera-dialog-actions">
            <button type="button" className="link-button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || trimmed.length === 0}>
              {submitting ? "Connecting…" : "Connect Course"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
