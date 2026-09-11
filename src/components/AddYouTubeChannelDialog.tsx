import { useState, type FormEvent } from "react";
import { addYouTubeCollection, CatalogApiError } from "../lib/catalogApi";

export interface AddYouTubeChannelDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  onClose: () => void;
  onAdded: () => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4K — connects a YouTube channel (URL, @handle, or bare channel ID)
 * and discovers its videos via the official RSS feed — never analyzing
 * any of them. Import-only; the resulting videos are plain project_source
 * rows, exactly like an à-la-carte add.
 */
export function AddYouTubeChannelDialog({ backendUrl, knoveraToken, projectId, onClose, onAdded }: AddYouTubeChannelDialogProps) {
  const [channelRef, setChannelRef] = useState("");
  const [state, setState] = useState<SubmitState>({ phase: "idle" });
  const submitting = state.phase === "submitting";
  const trimmed = channelRef.trim();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || trimmed.length === 0) return;
    setState({ phase: "submitting" });
    try {
      await addYouTubeCollection(backendUrl, knoveraToken, projectId, trimmed);
      onAdded();
    } catch (err) {
      setState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to add this YouTube channel. Please try again." });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="add-youtube-channel-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="add-youtube-channel-title">Add YouTube Channel</h2>
        <p className="knovera-dialog-subtitle">Discovers the channel's recent videos (via YouTube's own feed) without analyzing any of them.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="youtube-channel-ref">Channel URL, @handle, or ID</label>
          <input
            id="youtube-channel-ref"
            type="text"
            placeholder="https://www.youtube.com/@channelname"
            value={channelRef}
            onChange={(e) => setChannelRef(e.target.value)}
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
              {submitting ? "Adding…" : "Add Channel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
