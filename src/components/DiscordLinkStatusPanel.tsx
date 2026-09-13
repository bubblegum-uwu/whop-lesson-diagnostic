import { useEffect, useState } from "react";
import { getDiscordLinkStatus, unlinkDiscord, DiscordLinkApiError, type DiscordLinkStatus } from "../lib/discordAccountLinkApi";
import { getDiscordApplicationId, buildDiscordInstallUrl } from "../lib/discordAppConfig";

export interface DiscordLinkStatusPanelProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LoadState = { phase: "idle" } | { phase: "loading" } | { phase: "loaded"; status: DiscordLinkStatus } | { phase: "error"; message: string };

/**
 * Phase 4K-B (revised) — the Sources page's Discord install/link status
 * panel (spec section: install/link status UX). Deliberately shows NO
 * guild-picker, NO "install to server" affordance, and NO channel
 * list/refresh — this is a USER_INSTALL app; the ONLY thing to configure
 * is (1) installing the app to the operator's own Discord account and (2)
 * linking that Discord account to this Knovera identity. Captures always
 * land in the fixed "Discord Knowledge" inbox (see
 * defaultProjectInboxesRepo.ts) — there is no "current Discord
 * destination" to configure here.
 */
export function DiscordLinkStatusPanel({ backendUrl, knoveraToken }: DiscordLinkStatusPanelProps) {
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [unlinking, setUnlinking] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  async function load(url: string, token: string, cancelledRef: { current: boolean }) {
    setState({ phase: "loading" });
    try {
      const status = await getDiscordLinkStatus(url, token);
      if (!cancelledRef.current) setState({ phase: "loaded", status });
    } catch (err) {
      if (!cancelledRef.current) {
        setState({ phase: "error", message: err instanceof DiscordLinkApiError ? err.message : "Failed to load Discord link status." });
      }
    }
  }

  useEffect(() => {
    // Nothing to load without both — state is already { phase: "idle" }
    // by default (see useState above), so there is nothing to set here.
    if (!backendUrl || !knoveraToken) return;
    const cancelledRef = { current: false };
    void load(backendUrl, knoveraToken, cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [backendUrl, knoveraToken]);

  async function handleUnlink() {
    if (!backendUrl || !knoveraToken) return;
    setUnlinking(true);
    try {
      await unlinkDiscord(backendUrl, knoveraToken);
      setConfirmingUnlink(false);
      await load(backendUrl, knoveraToken, { current: false });
    } catch (err) {
      setState({ phase: "error", message: err instanceof DiscordLinkApiError ? err.message : "Failed to unlink Discord." });
    } finally {
      setUnlinking(false);
    }
  }

  const applicationId = getDiscordApplicationId();
  const linked = state.phase === "loaded" && state.status.linked;

  return (
    <div className="knovera-discord-link-panel">
      <div className="knovera-provider-card-top">
        <span className="hint">Discord account</span>
        {state.phase === "loaded" ? (
          linked ? (
            <span className="kv-badge kv-badge-accent">Linked ✓</span>
          ) : (
            <span className="kv-badge kv-badge-muted">Not Linked</span>
          )
        ) : null}
      </div>

      {state.phase === "error" && <p className="knovera-login-error">{state.message}</p>}

      <p className="knovera-provider-desc">
        Right-click a message with a video attachment in Discord → Apps → <strong>Save to Knovera</strong>. Captures always go to a
        permanent &quot;Discord Knowledge&quot; project — no server admin permissions are ever requested, and Knovera is never installed
        to a server.
      </p>

      <div className="knovera-provider-card-actions">
        {applicationId ? (
          <a className="knovera-provider-connect-button" href={buildDiscordInstallUrl(applicationId)} target="_blank" rel="noreferrer">
            Install Knovera on Discord
          </a>
        ) : (
          <span className="hint">Discord install is not configured for this deployment.</span>
        )}

        {linked &&
          (confirmingUnlink ? (
            <>
              <span className="hint">Unlink Discord? Future captures will need to re-link.</span>
              <button type="button" className="link-button" onClick={() => setConfirmingUnlink(false)} disabled={unlinking}>
                Cancel
              </button>
              <button type="button" className="link-button danger" onClick={() => void handleUnlink()} disabled={unlinking}>
                {unlinking ? "Unlinking…" : "Confirm Unlink"}
              </button>
            </>
          ) : (
            <button type="button" className="link-button danger" onClick={() => setConfirmingUnlink(true)}>
              Unlink Discord
            </button>
          ))}
      </div>
    </div>
  );
}
