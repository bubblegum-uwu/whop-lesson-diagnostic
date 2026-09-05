import { useEffect, useMemo, useState } from "react";
import { ConfigForm } from "./components/ConfigForm";
import { DiagnosticResult } from "./components/DiagnosticResult";
import { ErrorResult } from "./components/ErrorResult";
import { AnalyzeLesson } from "./components/AnalyzeLesson";
import {
  startWhopOAuth,
  exchangeCodeForTokens,
  parseCallbackParams,
} from "./oauth/whopOAuth";
import { parseWhopLessonUrl, WhopUrlParseError } from "./lib/whopUrl";
import { fetchCourseLesson, type LessonFetchOutcome } from "./lib/whopApi";
import { sanitizeLessonResponse } from "./lib/sanitize";
import { buildDiagnosticDisplayPayload, type DiagnosticDisplayPayload } from "./lib/diagnosticPayload";
import { saveConfig, loadConfig, clearConfig } from "./lib/sessionConfig";
import { getBackendUrl } from "./lib/backendConfig";

type AppState =
  | { phase: "config"; errorMessage: string | null; submitting: boolean }
  | { phase: "exchanging" }
  | { phase: "fetching" }
  // `accessToken` is kept ONLY in this in-memory React state (per PoC spec:
  // no localStorage/sessionStorage/cookies for the Whop access token). It's
  // used solely to let the user optionally trigger the Phase 2 backend
  // analysis, sent as an Authorization header and never rendered or logged.
  | { phase: "result"; payload: DiagnosticDisplayPayload; lessonUrl: string; accessToken: string }
  | { phase: "api_error"; outcome: Exclude<LessonFetchOutcome, { kind: "success" }> }
  | { phase: "fatal_error"; message: string };

function getRedirectUri(): string {
  // Must exactly match a redirect URI registered in the Whop Dashboard.
  const base = import.meta.env.BASE_URL; // e.g. "/" locally, "/repo-name/" on GH Pages
  return `${window.location.origin}${base}`;
}

export default function App() {
  const redirectUri = useMemo(getRedirectUri, []);
  const [state, setState] = useState<AppState>({
    phase: "config",
    errorMessage: null,
    submitting: false,
  });

  useEffect(() => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    const isCallback = params.has("code") || params.has("error");
    if (!isCallback) return;

    const config = loadConfig();
    if (!config) {
      setState({
        phase: "fatal_error",
        message:
          "Returned from Whop but no diagnostic config (client_id / lesson URL) was found for this session. Please start again.",
      });
      return;
    }

    // Clean the OAuth params out of the visible URL bar right away.
    window.history.replaceState({}, "", redirectUri);

    void runCallbackFlow(config.clientId, config.lessonUrl, search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCallbackFlow(clientId: string, lessonUrl: string, search: string) {
    setState({ phase: "exchanging" });
    try {
      const callback = parseCallbackParams(search);
      const tokens = await exchangeCodeForTokens(clientId, redirectUri, callback);

      const urlIds = parseWhopLessonUrl(lessonUrl);

      setState({ phase: "fetching" });
      const outcome = await fetchCourseLesson(urlIds.lessonId, tokens.access_token);

      if (outcome.kind === "success") {
        const sanitized = sanitizeLessonResponse(outcome.data);
        const payload = buildDiagnosticDisplayPayload(urlIds, sanitized);
        setState({ phase: "result", payload, lessonUrl, accessToken: tokens.access_token });
      } else {
        setState({ phase: "api_error", outcome });
      }
      // Beyond being kept in the "result" state above (in-memory only), the
      // local `tokens` variable is not stored anywhere else — no
      // localStorage/sessionStorage/cookies, never logged.
    } catch (err) {
      setState({
        phase: "fatal_error",
        message: err instanceof Error ? err.message : "Unknown error during OAuth callback.",
      });
    } finally {
      clearConfig();
    }
  }

  async function handleSubmit(clientId: string, lessonUrl: string) {
    if (!clientId) {
      setState({ phase: "config", errorMessage: "Please enter a client_id.", submitting: false });
      return;
    }
    try {
      parseWhopLessonUrl(lessonUrl);
    } catch (err) {
      setState({
        phase: "config",
        errorMessage:
          err instanceof WhopUrlParseError
            ? err.message
            : "Could not parse that lesson URL.",
        submitting: false,
      });
      return;
    }

    setState({ phase: "config", errorMessage: null, submitting: true });
    saveConfig({ clientId, lessonUrl });
    const authorizeUrl = await startWhopOAuth(clientId, redirectUri);
    window.location.href = authorizeUrl;
  }

  function handleReset() {
    clearConfig();
    setState({ phase: "config", errorMessage: null, submitting: false });
  }

  return (
    <div className="app-shell">
      {state.phase === "config" && (
        <ConfigForm
          redirectUri={redirectUri}
          onSubmit={handleSubmit}
          submitting={state.submitting}
          errorMessage={state.errorMessage}
        />
      )}

      {state.phase === "exchanging" && <p className="status-line">Exchanging authorization code for tokens…</p>}
      {state.phase === "fetching" && <p className="status-line">Fetching lesson from Whop…</p>}

      {state.phase === "result" && (
        <>
          <DiagnosticResult payload={state.payload} />
          {getBackendUrl() && (
            <AnalyzeLesson
              backendUrl={getBackendUrl()!}
              lessonUrl={state.lessonUrl}
              accessToken={state.accessToken}
            />
          )}
          <button onClick={handleReset}>Start over</button>
        </>
      )}

      {state.phase === "api_error" && (
        <>
          <ErrorResult outcome={state.outcome} />
          <button onClick={handleReset}>Start over</button>
        </>
      )}

      {state.phase === "fatal_error" && (
        <>
          <div className="error-panel" role="alert">
            <h2>ERROR</h2>
            <p>{state.message}</p>
          </div>
          <button onClick={handleReset}>Start over</button>
        </>
      )}
    </div>
  );
}
