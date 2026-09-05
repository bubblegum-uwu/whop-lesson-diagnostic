import { useState } from "react";

export type FindWhopUserIdState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "result"; sub: string }
  | { phase: "error"; message: string };

export interface FindWhopUserIdProps {
  state: FindWhopUserIdState;
  onStart: () => void;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * A one-time setup utility, entirely independent of this app's own backend:
 * it runs the existing browser OAuth sign-in, then calls Whop's own
 * userinfo endpoint directly from the browser to display the signed-in
 * user's `sub` — the value to set as WHOP_OPERATOR_USER_ID. This works even
 * before the backend is deployed or configured. The displayed id is not a
 * credential and nothing on this page sends it anywhere; you copy it
 * yourself into your own deployment configuration.
 */
export function FindWhopUserId({ state, onStart }: FindWhopUserIdProps) {
  return (
    <details className="setup-disclosure">
      <summary>First-time setup: find my Whop user ID</summary>
      <div className="setup-body">
        <p className="hint">
          Signs you in with Whop, then asks Whop directly (never this app's backend) who you
          are. Use the result to set <code>WHOP_OPERATOR_USER_ID</code> on the backend.
        </p>

        {state.phase === "idle" && <button onClick={onStart}>Sign in to find my user ID</button>}
        {state.phase === "running" && <p className="status-line">Signing in with Whop…</p>}

        {state.phase === "result" && (
          <div className="setup-result">
            <span className="mono-box">{state.sub}</span>
            <CopyButton value={state.sub} />
            <p className="hint">
              Set this on the backend as <code>WHOP_OPERATOR_USER_ID={state.sub}</code>. This is
              not a secret — it's a plain account identifier, safe to store as a normal
              environment variable.
            </p>
          </div>
        )}

        {state.phase === "error" && <div className="error-box">{state.message}</div>}
      </div>
    </details>
  );
}
