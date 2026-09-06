import { useEffect, useMemo, useState } from "react";
import { ConfigForm } from "./components/ConfigForm";
import { DiagnosticResult } from "./components/DiagnosticResult";
import { ErrorResult } from "./components/ErrorResult";
import { AnalyzeLesson } from "./components/AnalyzeLesson";
import { CourseTable } from "./components/CourseTable";
import { DashboardSummary } from "./components/DashboardSummary";
import { FindWhopUserId, type FindWhopUserIdState } from "./components/FindWhopUserId";
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
  // `accessToken` is kept ONLY in this in-memory React state (per PoC spec:
  // no localStorage/sessionStorage/cookies for the Whop access token). It's
  // used solely to let the user optionally trigger the Phase 2 backend
  // analysis, sent as an Authorization header and never rendered or logged.
  | { phase: "result"; payload: DiagnosticDisplayPayload; lessonUrl: string; accessToken: string }
  | { phase: "api_error"; outcome: Exclude<LessonFetchOutcome, { kind: "success" }> }
  | { phase: "fatal_error"; message: string };

interface CourseViewState {
  // Held only in memory, for the lifetime of this loaded page — never
  // localStorage/sessionStorage/cookies. Every protected course/auth call
  // needs it as a bearer header (the backend verifies it against Whop and
  // checks it's the authorized operator); a page reload clears it, so the
  // Course view requires signing in again before it can load. That's the
  // correct cost of not relying on CORS/Origin as a security boundary.
  accessToken: string | null;
  connecting: boolean;
  syncing: boolean;
  authRequired: boolean;
  connected: boolean;
  courseTitle: string | null;
  lastSyncedAt: string | null;
  lessons: CourseLessonSummary[];
  summary: AnalysisSummary | null;
  errorMessage: string | null;
}

const INITIAL_COURSE_STATE: CourseViewState = {
  accessToken: null,
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

  const [state, setState] = useState<AppState>({
    phase: "config",
    errorMessage: null,
    submitting: false,
  });
  const [courseState, setCourseState] = useState<CourseViewState>(INITIAL_COURSE_STATE);
  const [identifyState, setIdentifyState] = useState<FindWhopUserIdState>({ phase: "idle" });

  async function refreshCourseState(accessToken: string) {
    if (!backendUrl) return;
    try {
      const [authStatus, courseLessons, summary] = await Promise.all([
        getAuthStatus(backendUrl, accessToken),
        getCourseLessons(backendUrl, accessToken),
        getAnalysisSummary(backendUrl, accessToken).catch(() => null),
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

  // Live-notification layer only (PR2): on any event, reload full state from
  // Postgres via refreshCourseState — the SSE stream never carries the
  // record of what happened on its own. Reconnects safely on drop.
  useEffect(() => {
    if (!backendUrl || !courseState.accessToken || !courseState.connected) return undefined;
    const accessToken = courseState.accessToken;
    const unsubscribe = subscribeAnalysisEvents(backendUrl, accessToken, () => {
      void refreshCourseState(accessToken);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, courseState.accessToken, courseState.connected]);

  useEffect(() => {
    const search = window.location.search;
    const params = new URLSearchParams(search);
    const isCallback = params.has("code") || params.has("error");

    // No prior sign-in from this page load means no access token in hand —
    // nothing to present to the protected course/auth endpoints yet, so the
    // Course view simply starts in its "not connected" state (see
    // INITIAL_COURSE_STATE) until the operator signs in again.
    if (!isCallback) return;

    const config = loadConfig();
    if (!config) {
      setState({
        phase: "fatal_error",
        message:
          "Returned from Whop but no pending sign-in was found for this session. Please start again.",
      });
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
    }
  }

  async function runCourseCallbackFlow(search: string) {
    setCourseState((prev) => ({ ...prev, connecting: true, errorMessage: null }));
    try {
      const callback = parseCallbackParams(search);
      const tokens = await exchangeCodeForTokens(clientId!, redirectUri, callback);

      if (backendUrl) {
        if (!tokens.refresh_token) {
          throw new Error(
            "Whop did not return a refresh_token — check that this OAuth app is configured to issue one.",
          );
        }
        await establishAuthSession(backendUrl, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresIn: tokens.expires_in,
        });
        setCourseState((prev) => ({ ...prev, accessToken: tokens.access_token }));
        await refreshCourseState(tokens.access_token);
      }
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Whop sign-in failed.",
      }));
    } finally {
      clearConfig();
      setCourseState((prev) => ({ ...prev, connecting: false }));
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
    if (!backendUrl || !courseState.accessToken) return;
    const accessToken = courseState.accessToken;
    setCourseState((prev) => ({ ...prev, syncing: true, errorMessage: null }));
    const outcome = await syncCourse(backendUrl, accessToken);
    if (outcome.kind === "auth_required") {
      setCourseState((prev) => ({ ...prev, syncing: false, authRequired: true, connected: false }));
      return;
    }
    if (outcome.kind === "error") {
      setCourseState((prev) => ({ ...prev, syncing: false, errorMessage: outcome.message }));
      return;
    }
    await refreshCourseState(accessToken);
    setCourseState((prev) => ({ ...prev, syncing: false }));
  }

  async function handleCourseDisconnect() {
    if (!backendUrl || !courseState.accessToken) return;
    await disconnectAuthSession(backendUrl, courseState.accessToken);
    setCourseState(INITIAL_COURSE_STATE);
  }

  async function handleEnqueue(lessonIds: number[], force = false) {
    if (!backendUrl || !courseState.accessToken) return;
    const accessToken = courseState.accessToken;
    try {
      await enqueueAnalysisJobs(backendUrl, accessToken, lessonIds, force);
      await refreshCourseState(accessToken);
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to queue analysis.",
      }));
    }
  }

  async function handleRetry(jobId: string) {
    if (!backendUrl || !courseState.accessToken) return;
    const accessToken = courseState.accessToken;
    try {
      await retryAnalysisJob(backendUrl, accessToken, jobId);
      await refreshCourseState(accessToken);
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to retry job.",
      }));
    }
  }

  async function handleCancel(jobId: string) {
    if (!backendUrl || !courseState.accessToken) return;
    const accessToken = courseState.accessToken;
    await cancelAnalysisJob(backendUrl, accessToken, jobId);
    await refreshCourseState(accessToken);
  }

  async function handleLoadAnalysis(lessonId: number): Promise<unknown | null> {
    if (!backendUrl || !courseState.accessToken) return null;
    return getLessonAnalysisJson(backendUrl, courseState.accessToken, lessonId);
  }

  function handleReset() {
    clearConfig();
    setState({ phase: "config", errorMessage: null, submitting: false });
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

  return (
    <div className={backendUrl ? "app-shell app-shell-wide" : "app-shell"}>
      <FindWhopUserId state={identifyState} onStart={handleFindUserId} />

      {backendUrl && (
        <>
          <DashboardSummary summary={courseState.summary} />
          <CourseTable
            courseTitle={courseState.courseTitle}
            lessons={courseState.lessons}
            connected={courseState.connected}
            syncing={courseState.syncing}
            authRequired={courseState.authRequired}
            lastSyncedAt={courseState.lastSyncedAt}
            summary={courseState.summary}
            onSignIn={handleCourseSignIn}
            onSync={handleCourseSync}
            onDisconnect={handleCourseDisconnect}
            onEnqueue={handleEnqueue}
            onRetry={handleRetry}
            onCancel={handleCancel}
            onLoadAnalysis={handleLoadAnalysis}
          />
        </>
      )}
      {courseState.errorMessage && <div className="error-box">{courseState.errorMessage}</div>}

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
          {backendUrl && (
            <AnalyzeLesson
              backendUrl={backendUrl}
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
