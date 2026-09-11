import { useState, type FormEvent } from "react";
import { batchAddYouTubeSources, batchAddDiscordSources, batchAddWhopLessons, CatalogApiError, type BatchImportResponse, type WhopLessonBatchResponse } from "../lib/catalogApi";

export interface BatchImportDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  provider: "YOUTUBE" | "DISCORD" | "WHOP_LESSON";
  onClose: () => void;
  /** Called once the batch call completes (even a partial success) — the caller refreshes the sources list. */
  onImported: () => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string } | { phase: "done"; result: BatchImportResponse | WhopLessonBatchResponse };

const LABELS = {
  YOUTUBE: { title: "Bulk Import YouTube Videos", placeholder: "https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=..." },
  DISCORD: { title: "Bulk Import Discord Attachments", placeholder: "https://cdn.discordapp.com/attachments/...\nhttps://cdn.discordapp.com/attachments/..." },
  WHOP_LESSON: {
    title: "Bulk Import Whop Lessons",
    placeholder: "https://whop.com/company/exp_.../app/courses/cors_.../lessons/lesn_.../\nhttps://whop.com/company/exp_.../app/courses/cors_.../lessons/lesn_.../",
  },
} as const;

/**
 * Phase 4K — one URL per line, each independently validated/deduped/
 * imported by the backend batch endpoint; never fails the whole paste
 * because one line is malformed, and never analyzes anything. Cancel
 * (including the backdrop) never calls the API. WHOP_LESSON reuses this
 * same generic dialog shape — see whopCourses.ts's
 * createBatchAddWhopLessonsHandler doc comment for why importing an
 * individual Whop lesson still means syncing its course under the hood
 * (the native course -> lesson relational model, never flattened).
 */
export function BatchImportDialog({ backendUrl, knoveraToken, projectId, provider, onClose, onImported }: BatchImportDialogProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const submitting = state.phase === "submitting";
  const urls = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const labels = LABELS[provider];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || urls.length === 0) return;
    setState({ phase: "submitting" });
    try {
      const result =
        provider === "YOUTUBE"
          ? await batchAddYouTubeSources(backendUrl, knoveraToken, projectId, urls)
          : provider === "DISCORD"
            ? await batchAddDiscordSources(backendUrl, knoveraToken, projectId, urls)
            : await batchAddWhopLessons(backendUrl, knoveraToken, projectId, urls);
      setState({ phase: "done", result });
      onImported();
    } catch (err) {
      setState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to import URLs. Please try again." });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-import-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="batch-import-title">{labels.title}</h2>
        <p className="knovera-dialog-subtitle">Paste one URL per line. Each is validated and imported independently — nothing is analyzed.</p>

        {state.phase !== "done" ? (
          <form onSubmit={handleSubmit}>
            <textarea
              rows={6}
              placeholder={labels.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={submitting}
              autoFocus
              className="knovera-batch-import-textarea"
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
              <button type="submit" disabled={submitting || urls.length === 0}>
                {submitting ? "Importing…" : `Import ${urls.length || ""} URL${urls.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </form>
        ) : (
          <>
            <p>
              {state.result.addedCount} added · {state.result.duplicateCount} duplicate · {state.result.invalidCount} invalid
            </p>
            <ul className="knovera-batch-import-results">
              {state.result.results.map((r, i) => (
                <li key={i}>
                  <span className={`kv-badge ${r.kind === "added" ? "kv-badge-accent" : r.kind === "duplicate" ? "kv-badge-muted" : "kv-badge-danger"}`}>{r.kind}</span>
                  <span className="knovera-batch-import-url">{r.url}</span>
                  {r.message && <span className="hint">{r.message}</span>}
                </li>
              ))}
            </ul>
            <div className="knovera-dialog-actions">
              <button type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
