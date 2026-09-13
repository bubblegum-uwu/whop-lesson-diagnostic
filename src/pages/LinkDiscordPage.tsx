import { useEffect, useRef, useState } from "react";
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
  // Fix 6 (live validation) — the token is single-use server-side, so a
  // SECOND consume call for the same mount (e.g. React StrictMode's
  // deliberate dev-only double-invoke of effects — see main.tsx) always
  // comes back "invalid/expired/already used" even though the FIRST call
  // actually succeeded. A ref (unlike a local `let`/state variable reset on
  // every effect run) survives across StrictMode's synchronous
  // mount→cleanup→remount of the SAME component instance, so it
  // guarantees the consume request is only ever attempted once per mounted
  // page — never making the backend token itself replayable (the backend
  // still independently rejects a genuine second consume; this guard is
  // purely about not ISSUING a redundant one from this browser tab).
  //
  // Deliberately no `cancelled`/cleanup-based guard around the setState
  // calls below: with the ref above ensuring at most one request per
  // mount, there is no "newer" request whose result the response could
  // ever race against, and React 18+ safely no-ops a state update from a
  // component that has genuinely unmounted by the time the promise
  // settles (no warning, no leak) — adding one back would reintroduce
  // exactly this bug, since StrictMode's synthetic cleanup would still
  // fire (and flip a per-invocation `cancelled` flag) before the ONE real
  // request's promise resolves.
  const hasAttemptedConsumeRef = useRef(false);

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
    if (hasAttemptedConsumeRef.current) return;
    hasAttemptedConsumeRef.current = true;

    consumeDiscordLinkToken(backendUrl, knoveraToken, token)
      .then(() => setState({ phase: "success" }))
      .catch((err) => {
        setState({
          phase: "error",
          message: err instanceof DiscordLinkApiError ? err.message : "Failed to link your Discord account. Please try again.",
        });
      });
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
