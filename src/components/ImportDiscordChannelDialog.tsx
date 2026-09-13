import { useEffect, useState, type FormEvent } from "react";
import {
  detectDiscordCompanion,
  scanDiscordChannel,
  parseDiscordChannelUrl,
  DiscordChannelUrlParseError,
  type DiscordChannelScanHandle,
  type DiscordScanResult,
  type DiscordScanProgress,
} from "../lib/discordCompanionBridge";
import { parseYouTubeVideoUrl } from "../lib/youtubeUrl";
import { importYouTubeSourcesFromDiscordChannel, CatalogApiError, type DiscordImportResponse } from "../lib/catalogApi";

export interface ImportDiscordChannelDialogProps {
  backendUrl: string;
  knoveraToken: string;
  projectId: number;
  /** externalIds (canonical YouTube video ids) this project already has as sources — used only for the client-side preview estimate below; the backend commit call is always the authoritative source of truth for what's actually new vs. already-existing. */
  existingYouTubeExternalIds: ReadonlySet<string>;
  onClose: () => void;
  /** Called once the import call completes (even a partial success) — the caller refreshes the sources list. */
  onImported: () => void;
}

interface PreviewStats {
  occurrencesScanned: number;
  parseableOccurrences: number;
  unparseableOccurrences: number;
  uniqueVideoCount: number;
  newVideoCount: number;
  alreadyInProjectCount: number;
}

function computePreview(scan: DiscordScanResult, existingIds: ReadonlySet<string>): PreviewStats {
  const uniqueIds = new Set<string>();
  let unparseable = 0;
  for (const occ of scan.occurrences) {
    try {
      uniqueIds.add(parseYouTubeVideoUrl(occ.youtubeUrl).externalId);
    } catch {
      unparseable++;
    }
  }
  let newVideoCount = 0;
  let alreadyInProjectCount = 0;
  for (const id of uniqueIds) {
    if (existingIds.has(id)) alreadyInProjectCount++;
    else newVideoCount++;
  }
  return {
    occurrencesScanned: scan.occurrences.length,
    parseableOccurrences: scan.occurrences.length - unparseable,
    unparseableOccurrences: unparseable,
    uniqueVideoCount: uniqueIds.size,
    newVideoCount,
    alreadyInProjectCount,
  };
}

function channelLabel(scan: DiscordScanResult): string {
  return scan.channel.channelName ? `#${scan.channel.channelName}` : `Channel ${scan.channel.channelId}`;
}

type DialogState =
  | { phase: "detecting" }
  | { phase: "unavailable" }
  | { phase: "input"; error: string | null }
  | { phase: "scanning"; handle: DiscordChannelScanHandle; progress: DiscordScanProgress }
  | { phase: "preview"; scan: DiscordScanResult; preview: PreviewStats }
  | { phase: "importing"; scan: DiscordScanResult }
  | { phase: "imported"; response: DiscordImportResponse }
  | { phase: "error"; message: string };

/**
 * Phase 4K-C — "Import YouTube from a Channel." Takes ONLY a Discord
 * channel URL (never individual YouTube links, never a Discord message
 * paste) and delegates the actual scanning to the local browser companion
 * extension (see lib/discordCompanionBridge.ts) — this component never
 * talks to Discord itself and never sees a Discord auth token. Discovered
 * videos are committed via the existing Knovera session
 * (importYouTubeSourcesFromDiscordChannel), never the companion. Import
 * never analyzes anything — every created/updated source stays in its
 * normal NOT_ANALYZED state.
 */
export function ImportDiscordChannelDialog({
  backendUrl,
  knoveraToken,
  projectId,
  existingYouTubeExternalIds,
  onClose,
  onImported,
}: ImportDiscordChannelDialogProps) {
  const [state, setState] = useState<DialogState>({ phase: "detecting" });
  const [channelUrlInput, setChannelUrlInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    void detectDiscordCompanion().then(({ available }) => {
      if (cancelled) return;
      setState(available ? { phase: "input", error: null } : { phase: "unavailable" });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleScanSubmit(e: FormEvent) {
    e.preventDefault();
    let parsedChannel;
    try {
      parsedChannel = parseDiscordChannelUrl(channelUrlInput);
    } catch (err) {
      setState({ phase: "input", error: err instanceof DiscordChannelUrlParseError ? err.message : "Could not parse this Discord channel URL." });
      return;
    }
    const handle = scanDiscordChannel(`https://discord.com/channels/${parsedChannel.guildId}/${parsedChannel.channelId}`, (progress) => {
      setState((prev) => (prev.phase === "scanning" ? { ...prev, progress } : prev));
    });
    setState({ phase: "scanning", handle, progress: { scannedMessages: 0, foundOccurrences: 0 } });
    handle.result
      .then((scan) => setState({ phase: "preview", scan, preview: computePreview(scan, existingYouTubeExternalIds) }))
      .catch((err) => setState({ phase: "error", message: err instanceof Error ? err.message : "The channel scan failed. Please try again." }));
  }

  async function handleImport(scan: DiscordScanResult) {
    setState({ phase: "importing", scan });
    try {
      const response = await importYouTubeSourcesFromDiscordChannel(
        backendUrl,
        knoveraToken,
        projectId,
        scan.channel,
        scan.occurrences,
      );
      setState({ phase: "imported", response });
      onImported();
    } catch (err) {
      setState({ phase: "error", message: err instanceof CatalogApiError ? err.message : "Failed to import these videos. Please try again." });
    }
  }

  const busy = state.phase === "scanning" || state.phase === "importing";

  return (
    <div className="knovera-dialog-backdrop" role="presentation" onClick={() => !busy && onClose()}>
      <div className="knovera-dialog" role="dialog" aria-modal="true" aria-labelledby="import-discord-channel-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="import-discord-channel-title">Import YouTube from a Channel</h2>
        <p className="knovera-dialog-subtitle">
          Paste a Discord channel URL — Knovera scans it for YouTube links using your own logged-in browser, never a bot. Nothing is analyzed until
          you choose to.
        </p>

        {state.phase === "detecting" && <p className="knovera-sources-loading">Checking for the Knovera Browser Companion…</p>}

        {state.phase === "unavailable" && (
          <div className="kv-card knovera-empty-state" role="alert">
            <p>Knovera Browser Companion is required to scan Discord channels.</p>
            <p className="hint">
              Load the unpacked extension from the <code>browser-companion/</code> folder in this repository (Chrome → Extensions → Developer mode
              → Load unpacked), then reopen this dialog.
            </p>
            <div className="knovera-dialog-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {state.phase === "input" && (
          <form onSubmit={handleScanSubmit}>
            <label htmlFor="discord-channel-url">Discord Channel URL</label>
            <input
              id="discord-channel-url"
              type="text"
              placeholder="https://discord.com/channels/1218766394997346395/1219022089252503632"
              value={channelUrlInput}
              onChange={(e) => setChannelUrlInput(e.target.value)}
              autoFocus
              autoComplete="off"
            />
            {state.error && (
              <p className="knovera-field-error" role="alert">
                {state.error}
              </p>
            )}
            <div className="knovera-dialog-actions">
              <button type="button" className="link-button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" disabled={channelUrlInput.trim().length === 0}>
                Scan Channel
              </button>
            </div>
          </form>
        )}

        {state.phase === "scanning" && (
          <>
            <p className="knovera-sources-loading" aria-live="polite">
              Scanning… {state.progress.scannedMessages} messages checked · {state.progress.foundOccurrences} YouTube links found
            </p>
            <div className="knovera-dialog-actions">
              <button type="button" className="link-button" onClick={() => state.handle.cancel()}>
                Stop Scan
              </button>
            </div>
          </>
        )}

        {state.phase === "preview" && (
          <>
            {state.scan.cancelled && <p className="hint">Scan stopped early — showing results found so far.</p>}
            <ul className="knovera-batch-import-results">
              <li>Channel: {channelLabel(state.scan)}</li>
              <li>{state.scan.messagesScanned} Discord messages scanned</li>
              <li>{state.preview.occurrencesScanned} YouTube occurrences found</li>
              <li>{state.preview.uniqueVideoCount} unique YouTube videos</li>
              <li>{state.preview.newVideoCount} new YouTube source{state.preview.newVideoCount === 1 ? "" : "s"}</li>
              <li>{state.preview.alreadyInProjectCount} already exist{state.preview.alreadyInProjectCount === 1 ? "s" : ""} in this project</li>
              {state.preview.unparseableOccurrences > 0 && (
                <li className="hint">{state.preview.unparseableOccurrences} link(s) couldn't be recognized and will be skipped.</li>
              )}
            </ul>
            <div className="knovera-dialog-actions">
              <button type="button" className="link-button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" disabled={state.preview.occurrencesScanned === 0} onClick={() => void handleImport(state.scan)}>
                Import
              </button>
            </div>
          </>
        )}

        {state.phase === "importing" && <p className="knovera-sources-loading">Importing…</p>}

        {state.phase === "imported" && (
          <>
            <p>
              {state.response.newSourceCount} added · {state.response.newOriginCount} linked to existing sources ·{" "}
              {state.response.duplicateOriginCount} already recorded · {state.response.invalidCount} invalid
            </p>
            <ul className="knovera-batch-import-results">
              {state.response.results.map((r, i) => (
                <li key={i}>
                  <span
                    className={`kv-badge ${r.kind === "added" || r.kind === "existing_source_new_origin" ? "kv-badge-accent" : r.kind === "invalid" ? "kv-badge-danger" : "kv-badge-muted"}`}
                  >
                    {r.kind}
                  </span>
                  <span className="knovera-batch-import-url">{r.youtubeUrl}</span>
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

        {state.phase === "error" && (
          <>
            <p className="knovera-field-error" role="alert">
              {state.message}
            </p>
            <div className="knovera-dialog-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
