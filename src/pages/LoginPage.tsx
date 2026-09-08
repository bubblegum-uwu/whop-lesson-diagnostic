import { useState, type FormEvent } from "react";
import { KnoveraMark } from "../components/KnoveraMark";

export interface LoginPageProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  submitting: boolean;
  errorMessage: string | null;
}

/**
 * Phase 4D — the Knovera application login. Entirely separate from Whop:
 * no Whop branding, no "Sign in with Whop" here — that button lives on the
 * Sources page, where connecting a provider is a distinct, later action
 * (see KNOVERA_AUTH_VS_PROVIDER_AUTH in the Phase 4D PR description).
 * Single fixed operator identity — no registration, no forgot-password, no
 * social/magic-link options, per this phase's explicit scope.
 */
export function LoginPage({ onSubmit, submitting, errorMessage }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    void onSubmit(email, password);
  }

  return (
    <div className="knovera-landing">
      <div className="knovera-landing-topbar">
        <span className="kv-wordmark">
          <KnoveraMark size={20} />
          <span className="kv-wordmark-text">Knovera</span>
        </span>
      </div>

      <div className="knovera-login-body">
        <form className="kv-card knovera-login-card" onSubmit={handleSubmit}>
          <h1 className="knovera-login-title">Sign in</h1>
          <p className="knovera-login-subtitle">Enter your Knovera credentials to continue.</p>

          <label htmlFor="knovera-login-email">Email</label>
          <input
            id="knovera-login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />

          <label htmlFor="knovera-login-password">Password</label>
          <input
            id="knovera-login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {errorMessage && (
            <p className="knovera-login-error" role="alert">
              {errorMessage}
            </p>
          )}

          <button type="submit" disabled={submitting} className="knovera-login-submit">
            {submitting ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
