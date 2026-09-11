import { useEffect, useState } from "react";
import { listDiscordGuildChannels, importDiscordChannels, CatalogApiError, type DiscordChannelSummary } from "../lib/catalogApi";

export interface ImportDiscordChannelsDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  guildId: number;
  guildName: string;
  onClose: () => void;
  /** Called once at least one channel was successfully imported — the caller refreshes the collections list. */
  onImported: () => void;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; channels: DiscordChannelSummary[] }
  | { phase: "error"; message: string };

type ImportState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

/**
 * Phase 4K-B — "Choose Discord channels" (spec section 30/31). Explicit
 * checkbox selection only — never an "import everything" shortcut, and a
 * channel Knovera can't actually read (readable: false — bot lacks access,
 * or an unsupported type) is shown but disabled, never silently importable.
 */
export function ImportDiscordChannelsDialog({ backendUrl, knoveraToken, projectId, guildId, guildName, onClose, onImported }: ImportDiscordChannelsDialogProps) {
  const [loadState, setLoadState] = useState<LoadState>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importState, setImportState] = useState<ImportState>({ phase: "idle" });
  const submitting = importState.phase === "submitting";

  useEffect(() => {
    let cancelled = false;
    // No synchronous setLoadState here — initial state is already "loading"
    // (the dialog is remounted fresh each time it opens, one guildId for its
    // whole lifetime, so there's no later guildId change to reset for).
    listDiscordGuildChannels(backendUrl, knoveraToken, guildId)
      .then((result) => {
        if (!cancelled) setLoadState({ phase: "loaded", channels: result.channels });
      })
      .catch((err) => {
        if (!cancelled) setLoadState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to load this server's channels." });
      });
    return () => {
      cancelled = true;
    };
  }, [backendUrl, knoveraToken, guildId]);

  function toggle(channelId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  async function handleImport() {
    if (submitting || selected.size === 0) return;
    setImportState({ phase: "submitting" });
    try {
      await importDiscordChannels(backendUrl, knoveraToken, projectId, guildId, Array.from(selected));
      onImported();
    } catch (err) {
      setImportState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to import the selected channels. Please try again." });
    }
  }

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !submitting && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="import-discord-channels-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="import-discord-channels-title">Choose Discord channels — {guildName}</h2>
        <p className="knovera-dialog-subtitle">Knovera only imports the channels you explicitly select below. Nothing else in this server is ever accessed.</p>

        {loadState.phase === "loading" && <p className="status-line">Loading channels…</p>}
        {loadState.phase === "error" && (
          <p className="knovera-field-error" role="alert">
            {loadState.message}
          </p>
        )}

        {loadState.phase === "loaded" && (
          <>
            {loadState.channels.length === 0 && <p className="knovera-dialog-subtitle">No supported channels were found in this server.</p>}
            <ul className="knovera-discord-channel-list">
              {loadState.channels.map((channel) => (
                <li key={channel.id} className="knovera-discord-channel-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(channel.id)}
                      disabled={submitting || !channel.readable}
                      onChange={() => toggle(channel.id)}
                    />
                    <span>#{channel.name}</span>
                  </label>
                  {!channel.readable && <span className="kv-badge kv-badge-muted">Not accessible</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        {importState.phase === "error" && (
          <p className="knovera-field-error" role="alert">
            {importState.message}
          </p>
        )}

        <div className="knovera-dialog-actions">
          <button type="button" className="link-button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleImport()} disabled={submitting || selected.size === 0 || loadState.phase !== "loaded"}>
            {submitting ? "Importing…" : `Import Selected Channel${selected.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
