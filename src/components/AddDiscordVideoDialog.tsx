import { useState, type FormEvent } from "react";
import { parseDiscordVideoUrl, DiscordUrlParseError } from "../lib/discordUrl";
import { addDiscordSource, AddDiscordSourceError } from "../lib/sourcesApi";

export interface AddDiscordVideoDialogProps {
  backendUrl: string;
  /** The Knovera session token (Phase 4D) — never a Whop token. Adding a Discord source never requires Whop to be connected. */
  knoveraToken: string;
  projectId: number;
  onClose: () => void;
  /** Called once the attachment is really added (or was already present — see AddDiscordSourceResult.duplicate) — the caller refreshes the sources list. */
  onAdded: () => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4I — the "Add Discord Video" dialog, mirroring AddYouTubeVideoDialog
 * exactly. Validates the URL client-side first (the same pure parser the
 * backend uses, see lib/discordUrl.ts) so a malformed/unsupported URL never
 * even reaches the network; a URL that parses fine client-side is still
 * re-validated server-side, whose error message is shown verbatim on
 * failure. Cancel (including the backdrop) never calls the API.
 */
export function AddDiscordVideoDialog({ backendUrl, knoveraToken, projectId, onClose, onAdded }: AddDiscordVideoDialogProps) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const submitting = state.phase === "submitting";
  const trimmedUrl = url.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || trimmedUrl.length === 0) return;

    try {
      parseDiscordVideoUrl(trimmedUrl);
    } catch (err) {
      setState({ phase: "error", message: err instanceof DiscordUrlParseError ? err.message : "Invalid Discord attachment URL." });
      return;
    }

    setState({ phase: "submitting" });
    try {
      await addDiscordSource(backendUrl, knoveraToken, projectId, trimmedUrl);
      onAdded();
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof AddDiscordSourceError ? err.message : "Failed to add Discord video. Please try again.",
      });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div
        className="knovera-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-discord-video-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="add-discord-video-title">Add Discord Video</h2>

        <form onSubmit={handleSubmit}>
          <div className="knovera-youtube-url-field">
            <label htmlFor="discord-video-url">Discord Attachment URL</label>
            <input
              id="discord-video-url"
              type="text"
              placeholder="https://cdn.discordapp.com/attachments/.../clip.mp4"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={submitting}
              autoFocus
              autoComplete="off"
            />
          </div>

          {state.phase === "error" && (
            <p className="knovera-field-error" role="alert">
              {state.message}
            </p>
          )}

          <div className="knovera-dialog-actions knovera-youtube-dialog-actions">
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
