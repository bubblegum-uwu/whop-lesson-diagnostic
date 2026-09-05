import { useState, type FormEvent } from "react";

export interface ConfigFormProps {
  redirectUri: string;
  initialClientId?: string;
  initialLessonUrl?: string;
  onSubmit: (clientId: string, lessonUrl: string) => void;
  submitting?: boolean;
  errorMessage?: string | null;
}

const DEFAULT_LESSON_URL =
  "https://whop.com/scarface-trades-mastermind/exp_gdmood6JIzSsE7/app/courses/cors_4lb7N3oassoZwHJvrufOYy/lessons/lesn_6XyV2SKHYoU4YZdlMF81kl/";

export function ConfigForm({
  redirectUri,
  initialClientId = "",
  initialLessonUrl = DEFAULT_LESSON_URL,
  onSubmit,
  submitting = false,
  errorMessage = null,
}: ConfigFormProps) {
  const [clientId, setClientId] = useState(initialClientId);
  const [lessonUrl, setLessonUrl] = useState(initialLessonUrl);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(clientId.trim(), lessonUrl.trim());
  }

  return (
    <form onSubmit={handleSubmit} className="config-form">
      <h1>Whop Lesson Media Diagnostic</h1>
      <p className="subtitle">
        A read-only diagnostic for a single Whop course lesson. Uses documented
        Whop OAuth 2.1 + PKCE and the documented course lesson API. No password,
        no client secret, no scraping, no DRM bypass.
      </p>

      <label htmlFor="clientId">Whop OAuth client_id</label>
      <input
        id="clientId"
        type="text"
        placeholder="app_xxxxxxxxxxxx"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
        required
        autoComplete="off"
        spellCheck={false}
      />
      <p className="hint">
        This is a public OAuth client ID, not a secret. Create/find it in your
        Whop Developer Dashboard.
      </p>

      <label htmlFor="lessonUrl">Whop lesson URL</label>
      <input
        id="lessonUrl"
        type="text"
        placeholder={DEFAULT_LESSON_URL}
        value={lessonUrl}
        onChange={(e) => setLessonUrl(e.target.value)}
        required
        autoComplete="off"
        spellCheck={false}
      />

      <div className="redirect-uri-box">
        <strong>Redirect URI to register in Whop:</strong>
        <code>{redirectUri}</code>
      </div>

      {errorMessage && <div className="error-box">{errorMessage}</div>}

      <button type="submit" disabled={submitting}>
        {submitting ? "Redirecting to Whop..." : "Sign in with Whop"}
      </button>
    </form>
  );
}
