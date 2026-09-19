import { useEffect, useMemo, useState } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AppShellLayout } from "./components/AppShell";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { SynthesisPage } from "./pages/SynthesisPage";
import { SynthesisSetsPage } from "./pages/SynthesisSetsPage";
import { SynthesisSetDetailPage } from "./pages/SynthesisSetDetailPage";
import { CollectionDetailPage } from "./pages/CollectionDetailPage";
import { WhopAlaCarteDetailPage } from "./pages/WhopAlaCarteDetailPage";
import { WhopCourseDetailPage } from "./pages/WhopCourseDetailPage";
import { UsagePage } from "./pages/UsagePage";
import { LinkDiscordPage } from "./pages/LinkDiscordPage";
import {
  startWhopOAuth,
  exchangeCodeForTokens,
  parseCallbackParams,
} from "./oauth/whopOAuth";
import { saveConfig, loadConfig, clearConfig } from "./lib/sessionConfig";
import { getBackendUrl } from "./lib/backendConfig";
import { getWhopClientId } from "./lib/scarfaceCourseConfig";
import { knoveraLogin, knoveraLogout, getKnoveraMe, InvalidKnoveraCredentialsError } from "./lib/knoveraAuthApi";
import { loadKnoveraToken, saveKnoveraToken, clearKnoveraToken } from "./lib/knoveraSession";
import { takePendingDiscordLinkToken } from "./lib/discordLinkPending";
import { establishAuthSession, getAuthStatus, disconnectAuthSession } from "./lib/courseApi";

type KnoveraLoginState = { phase: "idle" } | { phase: "submitting" } | { phase: "error"; message: string };

interface CourseViewState {
  // Phase 4D: no longer holds a Whop access token at all (see the
  // top-level `knoveraToken` state below, and courseApi.ts's functions,
  // which now all take that instead). The only place a Whop OAuth
  // access/refresh token is ever held is transiently inside
  // runCourseCallbackFlow, right after exchange, purely to hand it to
  // establishAuthSession — never stored in ongoing state afterward.
  connecting: boolean;
  // LIVE Whop provider-connection state (GET /api/auth/status) — see
  // SourcesPage.tsx's doc comment on why this is kept separate from
  // whether a course/lessons/analyses have ever been persisted.
  //
  // Phase 4K follow-up: course-specific state (lessons, per-course
  // sync/analysis summary) no longer lives here — each Whop Course Detail
  // page now owns its own scoped copy (see WhopCourseDetailPage.tsx),
  // since Phase 4K made "the" single course assumption this state used to
  // encode obsolete. This is provider-connection state only.
  connected: boolean;
  errorMessage: string | null;
}

const INITIAL_COURSE_STATE: CourseViewState = {
  connecting: false,
  connected: false,
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

  const [courseState, setCourseState] = useState<CourseViewState>(INITIAL_COURSE_STATE);

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
      const authStatus = await getAuthStatus(backendUrl, token);
      setCourseState((prev) => ({ ...prev, connected: authStatus.connected }));
    } catch (err) {
      setCourseState((prev) => ({
        ...prev,
        errorMessage: err instanceof Error ? err.message : "Failed to load Whop connection state.",
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
      // Surfaced on the Whop provider card (see SourcesPage.tsx's
      // providerErrorMessage prop) — the same place a failed Connect Whop
      // attempt already shows an error, since this can legitimately happen
      // for that flow too (e.g. sessionStorage cleared mid-redirect).
      setCourseState((prev) => ({
        ...prev,
        errorMessage: "Returned from Whop but no pending sign-in was found for this session. Please start again.",
      }));
      navigate("/projects/mastermind/sources");
      return;
    }

    // Clean the OAuth params out of the visible URL bar right away.
    window.history.replaceState({}, "", redirectUri);

    if (config.flow === "course") {
      void runCourseCallbackFlow(search);
    } else {
      // The single-lesson diagnostic and find-my-user-id flows were removed
      // from the UI (no more Diagnostic Tools disclosure to resume into) —
      // a stray "identify"/"diagnostic" config here could only be a
      // leftover from a sign-in that was mid-flight when this change
      // deployed. Nothing left to resume; just discard it and land
      // somewhere real instead of stranding the operator on the bare
      // callback URL.
      clearConfig();
      navigate("/projects/mastermind/sources");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      navigate("/projects/mastermind/sources");
    }
  }

  async function handleCourseSignIn() {
    if (!clientId) return;
    saveConfig({ flow: "course" });
    const authorizeUrl = await startWhopOAuth(clientId, redirectUri);
    window.location.href = authorizeUrl;
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

  async function handleKnoveraLogin(email: string, password: string) {
    if (!backendUrl) return;
    setKnoveraLoginState({ phase: "submitting" });
    try {
      const { token } = await knoveraLogin(backendUrl, email, password);
      saveKnoveraToken(token);
      setKnoveraToken(token);
      setKnoveraLoginState({ phase: "idle" });
      // Phase 4K-B (revised) — if this login was reached via LinkDiscordPage
      // stashing a one-time Discord link token (because the operator wasn't
      // signed in yet when they opened the "Save to Knovera" link), resume
      // that flow instead of landing on /projects — see discordLinkPending.ts.
      const pendingDiscordLinkToken = takePendingDiscordLinkToken();
      if (pendingDiscordLinkToken) {
        navigate(`/link-discord?token=${encodeURIComponent(pendingDiscordLinkToken)}`);
        return;
      }
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
      <Route path="/link-discord" element={<LinkDiscordPage backendUrl={backendUrl} knoveraToken={knoveraToken} />} />
      <Route
        element={knoveraToken ? <AppShellLayout onLogout={handleKnoveraLogout} email={knoveraEmail} /> : <Navigate to="/login" replace />}
      >
        <Route path="/projects" element={<ProjectsPage backendUrl={backendUrl} knoveraToken={knoveraToken} />} />
        <Route path="/usage" element={<UsagePage backendUrl={backendUrl} knoveraToken={knoveraToken} />} />
        <Route
          path="/projects/:projectId/sources"
          element={
            <SourcesPage
              connected={courseState.connected}
              providerErrorMessage={courseState.errorMessage}
              onSignIn={handleCourseSignIn}
              onDisconnect={handleCourseDisconnect}
              backendUrl={backendUrl}
              knoveraToken={knoveraToken}
            />
          }
        />
        <Route
          path="/projects/:projectId/synthesis"
          element={<SynthesisPage backendUrl={backendUrl} knoveraToken={knoveraToken} connected={courseState.connected} />}
        />
        <Route
          path="/projects/:projectId/synthesis-sets"
          element={<SynthesisSetsPage backendUrl={backendUrl} knoveraToken={knoveraToken} />}
        />
        <Route
          path="/projects/:projectId/synthesis-sets/:setId"
          element={<SynthesisSetDetailPage backendUrl={backendUrl} knoveraToken={knoveraToken} />}
        />
        <Route
          path="/projects/:projectId/whop-ala-carte"
          element={<WhopAlaCarteDetailPage backendUrl={backendUrl} knoveraToken={knoveraToken} />}
        />
        <Route
          path="/projects/:projectId/collections/:collectionId"
          element={<CollectionDetailPage backendUrl={backendUrl} knoveraToken={knoveraToken} />}
        />
        <Route
          path="/projects/:projectId/whop-courses/:courseId"
          element={<WhopCourseDetailPage backendUrl={backendUrl} knoveraToken={knoveraToken} />}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
