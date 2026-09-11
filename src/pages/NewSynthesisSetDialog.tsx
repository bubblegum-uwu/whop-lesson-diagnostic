import { useState, type FormEvent } from "react";
import { createSynthesisSet, SynthesisSetError, type SynthesisSetSummary } from "../lib/synthesisSetsApi";

export interface NewSynthesisSetDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  onClose: () => void;
  /** Called once the set is really created (POST returned 201) — the caller refreshes the list and/or opens the new set. */
  onCreated: (set: SynthesisSetSummary) => void;
}

type SubmitState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4J — creates an empty, persistent Synthesis Set configuration.
 * Deliberately does nothing else: no source is selected here, no analysis
 * is triggered, no synthesis runs. Cancel (including the backdrop) never
 * calls the API, so it's guaranteed to create nothing.
 */
export function NewSynthesisSetDialog({ backendUrl, knoveraToken, projectId, onClose, onCreated }: NewSynthesisSetDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [state, setState] = useState<SubmitState>({ phase: "idle" });

  const trimmedName = name.trim();
  const nameError = nameTouched && trimmedName.length === 0 ? "Name is required." : null;
  const submitting = state.phase === "submitting";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setNameTouched(true);
    if (submitting || trimmedName.length === 0) return;

    setState({ phase: "submitting" });
    try {
      const set = await createSynthesisSet(backendUrl, knoveraToken, projectId, trimmedName, description.trim() || null);
      onCreated(set);
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof SynthesisSetError ? err.message : "Failed to create synthesis set. Please try again.",
      });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="new-synthesis-set-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="new-synthesis-set-title">New Synthesis Set</h2>
        <p className="knovera-dialog-subtitle">Name a group of sources you'll synthesize together. You'll pick sources on the next screen.</p>

        <form onSubmit={handleSubmit}>
          <label htmlFor="new-synthesis-set-name">Name</label>
          <input
            id="new-synthesis-set-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setNameTouched(true)}
            disabled={submitting}
            autoFocus
            autoComplete="off"
          />
          {nameError && (
            <p className="knovera-field-error" role="alert">
              {nameError}
            </p>
          )}

          <label htmlFor="new-synthesis-set-description">Description (optional)</label>
          <input
            id="new-synthesis-set-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            autoComplete="off"
          />

          {state.phase === "error" && (
            <p className="knovera-dialog-notice" role="alert">
              {state.message}
            </p>
          )}

          <div className="knovera-dialog-actions">
            <button type="button" className="link-button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || trimmedName.length === 0}>
              {submitting ? "Creating…" : "Create Synthesis Set"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
