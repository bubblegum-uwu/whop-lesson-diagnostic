import { useEffect, useMemo, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AppShellLayout } from "./components/AppShell";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SynthesisPage } from "./pages/SynthesisPage";
import { UsagePage } from "./pages/UsagePage";
import type { FindWhopUserIdState } from "./components/FindWhopUserId";
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
import { getWhopClientId } from "./lib/scarfaceCourseConfig";
import { fetchWhopUserInfo } from "./lib/whopIdentify";
import { knoveraLogin, knoveraLogout, getKnoveraMe, InvalidKnoveraCredentialsError } from "./lib/knoveraAuthApi";
import { loadKnoveraToken, saveKnoveraToken, clearKnoveraToken } from "./lib/knoveraSession";
import {
  establishAuthSession,
  getAuthStatus,
  disconnectAuthSession,
  syncCourse,
  getCourseLessons,
  getAnalysisSummary,
  enqueueAnalysisJobs,
  retryAnalysisJob,
  cancelAnalysisJob,
  getLessonAnalysisJson,
  subscribeAnalysisEvents,
  type CourseLessonSummary,
  type AnalysisSummary,
} from "./lib/courseApi";

type AppState =
  | { phase: "config"; errorMessage: string | null; submitting: boolean }
  | { phase: "exchanging" }
  | { phase: "fetching" }
  // This one remains a genuinely separate, short-lived Whop access token —
  // obtained by the standalone single-lesson diagnostic mini-flow, never
  // the Knovera session and never the persistent Whop provider connection.
  // Kept only in memory (no localStorage/sessionStorage), exactly as before.
  | { phase: "result"; payload: DiagnosticDisplayPayload; lessonUrl: string; accessToken: string }
  | { phase: "api_error"; outcome: Exclude<LessonFetchOutcome, { kind: "success" }> }
  | { phase: "fatal_error"; message: string };

type KnoveraLoginState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

interface CourseViewState {
  // Phase 4D: no longer holds a Whop access token at all (see the
  // top-level `knoveraToken` state below, and courseApi.ts's functions,
  // which now all take that instead). The only place a Whop OAuth
  // access/refresh token is ever held is transiently inside
  // runCourseCallbackFlow, right after exchange, purely to hand it to
  // establishAuthSession — never stored in ongoing state afterward.
  connecting: boolean;
  syncing: boolean;
  authRequired: boolean;
  // LIVE Whop provider-connection state (GET /api/auth/status) — see
  // SourcesPage.tsx's doc comment on why this is kept separate from
  // whether a course/lessons/analyses have ever been persisted.
  connected: boolean;
  courseTitle: string | null;
  lastSyncedAt: string | null;
  lessons: CourseLessonSummary[];
  summary: AnalysisSummary | null;
  errorMessage: string | null;
}

const INITIAL_COURSE_STATE: CourseViewState = {
  connecting: false,
  syncing: false,
  authRequired: false,
  connected: false,
  courseTitle: null,
  lastSyncedAt: null,
  lessons: [],
  summary: null,
  errorMessage: null,
};

function getRedirectUri(): string {
  // Must exactly match a redirect URI registered in the Whop Dashboard.
  const base = import.meta.env.BASE_URL; // e.g. "/" locally, "/repo-name/" on GH Pages
  return `${window.location.origin}${base}`;
}

export default function App() {
  const redirectUri = useMemo(getRedirectUri, []);
  const clientId = useMemo(getWhopClientId, []);
  const backendUrl = useMemo(getBackendUrl, []);
  const navigate = useNavigate();

  const [state, setState] = useState<AppState>({
    phase: "config",
    errorMessage: null,
    submitting: false,
  });
  const [courseState, setCourseState] = useState<CourseViewState>(INITIAL_COURSE_STATE);
  const [identifyState, setIdentifyState] = useState<FindWhopUserIdState>({ phase: "idle" });

  // Phase 4D — the Knovera application session, entirely separate from Whop
  // (see KNOVERA_AUTH_VS_PROVIDER_AUTH in the Phase 4D PR description).
  // Hydrated synchronously from sessionStorage so it survives the full-page
  // redirect round trip to Whop's authorize page and back (e.g. mid-way
  // through Connect Whop), and so a same-tab reload doesn't force a fresh
  // login within the token's 12h server-side expiry — see knoveraSession.ts
  // for why sessionStorage (not localStorage) was chosen.
  const [knoveraToken, setKnoveraToken] = useState<string | null>(() => loadKnoveraToken());
  const [knoveraLoginState, setKnoveraLoginState] = useState<KnoveraLoginState>({ phase: "idle" });
  // Phase 4D.1 — the authenticated operator's email, surfaced for the
  // AppShell account menu. Populated from the same /api/knovera-auth/me
  // check the effect below already performs to validate the held token;
  // no new backend call.
  const [knoveraEmail, setKnoveraEmail] = useState<string | null>(null);

  // Phase 4D — verifies a held Knovera token (whether just restored from
  // sessionStorage on page load, or freshly issued by handleKnoveraLogin)
  // is still accepted by the backend. An expired/invalid token clears
  // itself and sends the operator back to /login, rather than leaving a
  // stale token in sessionStorage that would otherwise only surface as a
  // confusing 401 the next time some API call happened to run. A network
  // failure while checking is NOT treated as invalid — it fails safe by
  // leaving the existing token in place.
  useEffect(() => {
    if (!backendUrl || !knoveraToken) return;
    let cancelled = false;
    getKnoveraMe(backendUrl, knoveraToken)
      .then((me) => {
        if (cancelled) return;
        if (!me) {
          clearKnoveraToken();
          setKnoveraToken(null);
          navigate("/login");
          return;
        }
        setKnoveraEmail(me.email);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken]);

  async function refreshCourseState(token: string) {
    if (!backendUrl) return;
    try {
      const [authStatus, courseLessons, summary] = await Promise.all([
        getAuthStatus(backendUrl, token),
        getCourseLessons(backendUrl, token),
        getAnalysisSummary(backendUrl, token).catch(() => null),
      ]);
      setCourseState((prev) => ({
        ...prev,
        connected: authStatus.connected,
        authRequired: authStatus.status === "auth_required",
        courseTitle: courseLessons.course?.title ?? null,
        lastSyncedAt: courseLessons.course?.lastSyncedAt ?? null,
        lessons: courseLessons.lessons,
        summary,
      }));
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to load course state.",
      }));
    }
  }

  // Once logged into Knovera, load the persisted course/lesson/analysis
  // state immediately — this is what makes Projects/Sources/Synthesis work
  // with Whop fully disconnected (see Phase 4D's core requirement): nothing
  // here depends on courseState.connected being true first.
  useEffect(() => {
    if (!backendUrl || !knoveraToken) return;
    void refreshCourseState(knoveraToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken]);

  // Live-notification layer only (PR2): on any event, reload full state from
  // Postgres via refreshCourseState — the SSE stream never carries the
  // record of what happened on its own. Reconnects safely on drop. Uses the
  // Knovera token (Phase 4D) — this stream is a Knovera-authed read, not a
  // Whop-gated one.
  useEffect(() => {
    if (!backendUrl || !knoveraToken) return undefined;
    const token = knoveraToken;
    const unsubscribe = subscribeAnalysisEvents(backendUrl, token, () => {
      void refreshCourseState(token);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, knoveraToken]);

  useEffect(() => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    const isCallback = params.has("code") || params.has("error");

    // No prior sign-in from this page load means nothing to present to the
    // protected course/auth endpoints yet, so the Course view simply starts
    // in its "not connected" state (see INITIAL_COURSE_STATE) until the
    // operator connects Whop again.
    if (!isCallback) return;

    const config = loadConfig();
    if (!config) {
      setState({
        phase: "fatal_error",
        message:
          "Returned from Whop but no pending sign-in was found for this session. Please start again.",
      });
      // Phase 4A addition — see runIdentifyCallbackFlow's comment below: this
      // state now renders on the Sources page (Diagnostic Tools), not inline
      // on whatever route happened to be active, so it needs the same
      // post-callback navigation the other three flows already get.
      navigate("/projects/mastermind/sources");
      return;
    }

    // Clean the OAuth params out of the visible URL bar right away.
    window.history.replaceState({}, "", redirectUri);

    if (config.flow === "course") {
      void runCourseCallbackFlow(search);
    } else if (config.flow === "identify") {
      void runIdentifyCallbackFlow(search);
    } else {
      void runDiagnosticCallbackFlow(config.lessonUrl, search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runIdentifyCallbackFlow(search: string) {
    setIdentifyState({ phase: "running" });
    try {
      const callback = parseCallbackParams(search);
      const tokens = await exchangeCodeForTokens(clientId!, redirectUri, callback);
      // Deliberately never touches this app's backend — Whop tells us
      // directly who just signed in.
      const userInfo = await fetchWhopUserInfo(tokens.access_token);
      setIdentifyState({ phase: "result", sub: userInfo.sub });
    } catch (err) {
      setIdentifyState({
        phase: "error",
        message: err instanceof Error ? err.message : "Could not determine your Whop user ID.",
      });
    } finally {
      clearConfig();
      // Phase 4A addition — a pure post-completion in-app navigation call, not
      // part of the OAuth mechanics above (token exchange/parsing/session
      // establishment are all untouched). Sends the user to the page that now
      // displays this flow's result (see SourcesPage's "Diagnostic Tools"),
      // since window.history.replaceState above clears the hash back to "/".
      // Note (Phase 4D): the Sources route now requires a Knovera session —
      // if this standalone tool is used while signed out of Knovera, this
      // navigation lands on /login instead, a known, accepted limitation of
      // this secondary tool (see the Phase 4D PR description).
      navigate("/projects/mastermind/sources");
    }
  }

  async function runCourseCallbackFlow(search: string) {
    setCourseState((prev) => ({ ...prev, connecting: true, errorMessage: null }));
    try {
      const callback = parseCallbackParams(search);
      const tokens = await exchangeCodeForTokens(clientId!, redirectUri, callback);

      if (backendUrl && knoveraToken) {
        if (!tokens.refresh_token) {
          throw new Error(
            "Whop did not return a refresh_token — check that this OAuth app is configured to issue one.",
          );
        }
        // The Whop access/refresh tokens live only in this local `tokens`
        // variable — handed to establishAuthSession's request body (which
        // persists them server-side, encrypted) and never stored in React
        // state afterward. Authorization for this call itself is the
        // Knovera token, not these Whop tokens (see courseApi.ts).
        await establishAuthSession(backendUrl, knoveraToken, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
        });
        await refreshCourseState(knoveraToken);
      }
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Whop sign-in failed.",
      }));
    } finally {
      clearConfig();
      setCourseState((prev) => ({ ...prev, connecting: false }));
      // Phase 4A addition — see runIdentifyCallbackFlow's comment above.
      navigate("/projects/mastermind/sources");
    }
  }

  async function runDiagnosticCallbackFlow(lessonUrl: string, search: string) {
    setState({ phase: "exchanging" });
    try {
      const callback = parseCallbackParams(search);
      const tokens = await exchangeCodeForTokens(clientId!, redirectUri, callback);

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
      // Phase 4A addition — see runIdentifyCallbackFlow's comment above.
      navigate("/projects/mastermind/sources");
    }
  }

  async function handleSubmit(lessonUrl: string) {
    if (!clientId) return; // guarded by the "not configured" screen below
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
    saveConfig({ flow: "diagnostic", lessonUrl });
    const authorizeUrl = await startWhopOAuth(clientId, redirectUri);
    window.location.href = authorizeUrl;
  }

  async function handleCourseSignIn() {
    if (!clientId) return;
    saveConfig({ flow: "course" });
    const authorizeUrl = await startWhopOAuth(clientId, redirectUri);
    window.location.href = authorizeUrl;
  }

  async function handleFindUserId() {
    if (!clientId) return;
    saveConfig({ flow: "identify" });
    const authorizeUrl = await startWhopOAuth(clientId, redirectUri);
    window.location.href = authorizeUrl;
  }

  async function handleCourseSync() {
    if (!backendUrl || !knoveraToken) return;
    setCourseState((prev) => ({ ...prev, syncing: true, errorMessage: null }));
    const outcome = await syncCourse(backendUrl, knoveraToken);
    if (outcome.kind === "auth_required") {
      // Phase 4D: this 401 means the WHOP provider connection is stale
      // (courseSync.ts's own getValidAccessToken/AuthRequiredError path,
      // behind requireWhopConnected's fast pre-check) — never the Knovera
      // session, which is a separate, unaffected credential.
      setCourseState((prev) => ({ ...prev, syncing: false, authRequired: true, connected: false }));
      return;
    }
    if (outcome.kind === "error") {
      setCourseState((prev) => ({ ...prev, syncing: false, errorMessage: outcome.message }));
      return;
    }
    await refreshCourseState(knoveraToken);
    setCourseState((prev) => ({ ...prev, syncing: false }));
  }

  /**
   * Disconnects the Whop provider connection only. Phase 4D requirement:
   * this must NEVER touch the Knovera session — no navigation to /login, no
   * clearing knoveraToken. Projects/MasterMind/existing lessons/analyses/
   * synthesis all remain visible immediately after, driven by the same
   * refreshCourseState() call every other mutation already uses.
   */
  async function handleCourseDisconnect() {
    if (!backendUrl || !knoveraToken) return;
    await disconnectAuthSession(backendUrl, knoveraToken);
    await refreshCourseState(knoveraToken);
  }

  async function handleEnqueue(lessonIds: number[], force = false) {
    if (!backendUrl || !knoveraToken) return;
    try {
      await enqueueAnalysisJobs(backendUrl, knoveraToken, lessonIds, force);
      await refreshCourseState(knoveraToken);
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to queue analysis.",
      }));
    }
  }

  async function handleRetry(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    try {
      await retryAnalysisJob(backendUrl, knoveraToken, jobId);
      await refreshCourseState(knoveraToken);
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to retry job.",
      }));
    }
  }

  async function handleCancel(jobId: string) {
    if (!backendUrl || !knoveraToken) return;
    await cancelAnalysisJob(backendUrl, knoveraToken, jobId);
    await refreshCourseState(knoveraToken);
  }

  async function handleLoadAnalysis(lessonId: number): Promise<unknown | null> {
    if (!backendUrl || !knoveraToken) return null;
    return getLessonAnalysisJson(backendUrl, knoveraToken, lessonId);
  }

  function handleReset() {
    clearConfig();
    setState({ phase: "config", errorMessage: null, submitting: false });
  }

  async function handleKnoveraLogin(email: string, password: string) {
    if (!backendUrl) return;
    setKnoveraLoginState({ phase: "submitting" });
    try {
      const { token } = await knoveraLogin(backendUrl, email, password);
      saveKnoveraToken(token);
      setKnoveraToken(token);
      setKnoveraLoginState({ phase: "idle" });
      navigate("/projects");
    } catch (err) {
      setKnoveraLoginState({
        phase: "error",
        message: err instanceof InvalidKnoveraCredentialsError ? err.message : "Login failed. Please try again.",
      });
    }
  }

  /**
   * Ends the Knovera session. Best-effort server call (see
   * lib/knoveraAuthApi.ts's knoveraLogout — this is a stateless token, so
   * nothing is actually revoked server-side); the local token discard below
   * is what actually ends the session for this browser.
   */
  async function handleKnoveraLogout() {
    if (backendUrl && knoveraToken) {
      await knoveraLogout(backendUrl, knoveraToken);
    }
    clearKnoveraToken();
    setKnoveraToken(null);
    setKnoveraEmail(null);
    setCourseState(INITIAL_COURSE_STATE);
    navigate("/login");
  }

  if (!clientId) {
    return (
      <div className="app-shell">
        <div className="error-panel" role="alert">
          <h2>Whop OAuth is not configured.</h2>
        </div>
      </div>
    );
  }

  // Phase 4D — /login and everything under AppShellLayout (Projects/Sources/
  // Synthesis/Usage) now requires a Knovera session; Whop is no longer
  // involved in reaching any of them. Every handler/effect above otherwise
  // keeps the same Whop OAuth mechanics untouched (PKCE, callback parsing,
  // token exchange) — this return only decides WHERE state renders and
  // which routes require being logged into Knovera first.
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route
        path="/login"
        element={
          knoveraToken ? (
            <Navigate to="/projects" replace />
          ) : (
            <LoginPage
              onSubmit={handleKnoveraLogin}
              submitting={knoveraLoginState.phase === "submitting"}
              errorMessage={knoveraLoginState.phase === "error" ? knoveraLoginState.message : null}
            />
          )
        }
      />
      <Route
        element={knoveraToken ? <AppShellLayout onLogout={handleKnoveraLogout} email={knoveraEmail} /> : <Navigate to="/login" replace />}
      >
        <Route path="/projects" element={<ProjectsPage backendUrl={backendUrl} knoveraToken={knoveraToken} />} />
        <Route path="/usage" element={<UsagePage />} />
        <Route
          path="/projects/:projectId/sources"
          element={
            <SourcesPage
              courseTitle={courseState.courseTitle}
              lessons={courseState.lessons}
              connected={courseState.connected}
              syncing={courseState.syncing}
              authRequired={courseState.authRequired}
              lastSyncedAt={courseState.lastSyncedAt}
              summary={courseState.summary}
              courseErrorMessage={courseState.errorMessage}
              onSignIn={handleCourseSignIn}
              onSync={handleCourseSync}
              onDisconnect={handleCourseDisconnect}
              onEnqueue={handleEnqueue}
              onRetry={handleRetry}
              onCancel={handleCancel}
              onLoadAnalysis={handleLoadAnalysis}
              identifyState={identifyState}
              onFindUserId={handleFindUserId}
              backendUrl={backendUrl}
              knoveraToken={knoveraToken}
              diagnosticState={state}
              redirectUri={redirectUri}
              onDiagnosticSubmit={handleSubmit}
              onDiagnosticReset={handleReset}
            />
          }
        />
        <Route
          path="/projects/:projectId/synthesis"
          element={<SynthesisPage backendUrl={backendUrl} knoveraToken={knoveraToken} connected={courseState.connected} />}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
