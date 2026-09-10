import { useState, type FormEvent } from "react";
import { parseYouTubeVideoUrl, YouTubeUrlParseError } from "../lib/youtubeUrl";
import { addYouTubeSource, AddYouTubeSourceError } from "../lib/sourcesApi";

export interface AddYouTubeVideoDialogProps {
  backendUrl: string;
  /** The Knovera session token (Phase 4D) — never a Whop token. Adding a YouTube source never requires Whop to be connected. */
  knoveraToken: string;
  projectId: number;
  onClose: () => void;
  /** Called once the video is really added (or was already present — see AddYouTubeSourceResult.duplicate) — the caller refreshes the sources list. */
  onAdded: () => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4H-A — the restrained "Add YouTube Video" dialog. Validates the
 * URL client-side first (the same pure parser the backend uses, see
 * lib/youtubeUrl.ts) so a malformed/unsupported URL never even reaches the
 * network; a URL that parses fine client-side is still re-validated
 * server-side, whose error message is shown verbatim on failure. Cancel
 * (including the backdrop) never calls the API — guaranteed to add nothing.
 */
export function AddYouTubeVideoDialog({ backendUrl, knoveraToken, projectId, onClose, onAdded }: AddYouTubeVideoDialogProps) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const submitting = state.phase === "submitting";
  const trimmedUrl = url.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || trimmedUrl.length === 0) return;

    try {
      parseYouTubeVideoUrl(trimmedUrl);
    } catch (err) {
      setState({ phase: "error", message: err instanceof YouTubeUrlParseError ? err.message : "Invalid YouTube URL." });
      return;
    }

    setState({ phase: "submitting" });
    try {
      await addYouTubeSource(backendUrl, knoveraToken, projectId, trimmedUrl);
      onAdded();
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof AddYouTubeSourceError ? err.message : "Failed to add YouTube video. Please try again.",
      });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div
        className="knovera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-youtube-video-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="add-youtube-video-title">Add YouTube Video</h2>

        <form onSubmit={handleSubmit}>
          <label htmlFor="youtube-video-url">YouTube URL</label>
          <input
            id="youtube-video-url"
            type="text"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
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
            <button type="submit" disabled={submitting || trimmedUrl.length === 0}>
              {submitting ? "Adding…" : "Add Video"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
