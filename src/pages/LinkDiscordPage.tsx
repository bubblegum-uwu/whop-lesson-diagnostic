import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { consumeDiscordLinkToken, DiscordLinkApiError } from "../lib/discordAccountLinkApi";
import { savePendingDiscordLinkToken } from "../lib/discordLinkPending";

export interface LinkDiscordPageProps {
  backendUrl: string | null;
  knoveraToken: string | null;
}

type LinkState = { phase: "linking" } | { phase: "success" } | { phase: "error"; message: string };

/**
 * "/link-discord?token=..." — Phase 4K-B (revised). The landing page for
 * the link Discord's "Save to Knovera" reply hands an unlinked user
 * (backend/src/http/routes/discordInteractions.ts). A TOP-LEVEL route
 * (see App.tsx), reachable whether or not this browser is currently
 * signed into Knovera — unlike every other route, it must never bounce
 * straight to /login before this component runs, or the one-time token in
 * the URL would be lost. If not signed in, this stashes the token
 * (sessionStorage — see discordLinkPending.ts) and sends the operator to
 * /login; App.tsx's handleKnoveraLogin picks it back up after a
 * successful sign-in and returns here with the token restored.
 *
 * The token itself is never typed or supplied by this browser — it is
 * read verbatim from the URL Discord's ephemeral reply provided, and the
 * backend is the only place that ever maps it to a Discord user id (see
 * discordAccountLinkApi.ts's doc comment).
 */
export function LinkDiscordPage({ backendUrl, knoveraToken }: LinkDiscordPageProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token");
  const [state, setState] = useState<LinkState>({ phase: "linking" });

  useEffect(() => {
    if (!token) {
      setState({ phase: "error", message: 'This link is missing its token. Please invoke "Save to Knovera" again in Discord to get a fresh link.' });
      return;
    }
    if (!backendUrl) return;
    if (!knoveraToken) {
      savePendingDiscordLinkToken(token);
      navigate("/login");
      return;
    }

    let cancelled = false;
    consumeDiscordLinkToken(backendUrl, knoveraToken, token)
      .then(() => {
        if (!cancelled) setState({ phase: "success" });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            phase: "error",
            message: err instanceof DiscordLinkApiError ? err.message : "Failed to link your Discord account. Please try again.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken, token]);

  return (
    <div className="knovera-page">
      <div className="kv-card knovera-empty-state">
        {state.phase === "linking" && <p>Linking your Discord account…</p>}
        {state.phase === "success" && (
          <>
            <p>Your Discord account is linked to Knovera.</p>
            <p className="hint">Go back to Discord and invoke &quot;Save to Knovera&quot; again on your message.</p>
            <button type="button" onClick={() => navigate("/projects")}>
              Go to Projects
            </button>
          </>
        )}
        {state.phase === "error" && (
          <>
            <p role="alert">{state.message}</p>
            <button type="button" className="link-button" onClick={() => navigate("/projects")}>
              Go to Projects
            </button>
          </>
        )}
      </div>
    </div>
  );
}
