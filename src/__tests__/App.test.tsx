import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";

const ORIGINAL_CLIENT_ID = import.meta.env.VITE_WHOP_CLIENT_ID;
const ORIGINAL_BACKEND_URL = import.meta.env.VITE_BACKEND_URL;
const KNOVERA_TOKEN_STORAGE_KEY = "knovera_session_token";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderApp(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  );
}

/**
 * Seeds a Knovera session directly into sessionStorage the same way
 * knoveraSession.ts's saveKnoveraToken does, so a test can render App
 * already "logged into Knovera" without going through the login form.
 * VITE_BACKEND_URL stays unset for these callers, so App.tsx's own
 * effects that would otherwise call the backend (refreshCourseState, the
 * on-mount getKnoveraMe check) short-circuit — this only exercises the
 * routing gate itself.
 */
function seedKnoveraSession(token = "seeded-knovera-token") {
  sessionStorage.setItem(KNOVERA_TOKEN_STORAGE_KEY, token);
}

describe("App — Phase 4A routing shell", () => {
  beforeEach(() => {
    import.meta.env.VITE_WHOP_CLIENT_ID = "test_client_id";
    sessionStorage.clear();
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    import.meta.env.VITE_WHOP_CLIENT_ID = ORIGINAL_CLIENT_ID;
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the Whop-OAuth-not-configured screen when no client id is set (unrelated to routing)", () => {
    import.meta.env.VITE_WHOP_CLIENT_ID = "";
    renderApp("/");
    expect(screen.getByText("Whop OAuth is not configured.")).toBeInTheDocument();
  });

  it("renders the Landing page at / when configured", () => {
    renderApp("/");
    expect(screen.getByText("Knovera")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter Knovera" })).toBeInTheDocument();
  });

  it("Phase 4D: redirects /projects to the Knovera login screen when signed out (no Whop token needed to reach Projects, but a Knovera session still gates it)", () => {
    renderApp("/projects");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("Phase 4D: redirects /projects/mastermind/sources to the Knovera login screen when signed out", () => {
    renderApp("/projects/mastermind/sources");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("Phase 4D: redirects /usage to the Knovera login screen when signed out", () => {
    renderApp("/usage");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("renders the Projects page directly at /projects once a Knovera session exists — no Whop connection required", () => {
    seedKnoveraSession();
    renderApp("/projects");
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("renders the Sources workspace directly at /projects/mastermind/sources once a Knovera session exists (refreshable hash route)", () => {
    seedKnoveraSession();
    renderApp("/projects/mastermind/sources");
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
  });

  it("renders the Usage page directly at /usage once a Knovera session exists", () => {
    seedKnoveraSession();
    renderApp("/usage");
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
  });

  /**
   * Phase 4A — the Whop OAuth callback logic (App.tsx's useEffect reading
   * window.location.search, parseCallbackParams, exchangeCodeForTokens,
   * clearConfig) is completely untouched by routing. This exercises the
   * "identify" flow (find-my-Whop-user-id) end to end through the REAL
   * window.location.search — HashRouter/MemoryRouter never touch
   * location.search, only location.hash, so this must keep working exactly
   * as it did on the pre-Phase-4 single-page app.
   *
   * Phase 4D: the post-callback navigation lands on the Sources route,
   * which now requires a Knovera session — so this test seeds one first,
   * the same as any other already-logged-into-Knovera operator using this
   * standalone tool.
   */
  it("OAuth callback: reads window.location.search, completes the identify flow, and resumes on the Sources page (Diagnostic Tools) where the result is now visible", async () => {
    seedKnoveraSession();
    sessionStorage.setItem("whop_oauth_pkce", JSON.stringify({ codeVerifier: "verifier123", state: "state123", nonce: "nonce123" }));
    sessionStorage.setItem("whop_diagnostic_config", JSON.stringify({ flow: "identify" }));
    // Simulates the real post-redirect URL: no hash, just the OAuth query
    // params — exactly what Whop redirects back to, since redirectUri never
    // includes a hash. Using pushState (not a real navigation) so jsdom
    // doesn't attempt to actually load a new page.
    window.history.pushState({}, "", "/?code=auth_code_abc&state=state123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://api.whop.com/oauth/token") {
          return jsonResponse(200, { access_token: "whop_access_token", token_type: "bearer", expires_in: 3600 });
        }
        if (url === "https://api.whop.com/oauth/userinfo") {
          return jsonResponse(200, { sub: "user_abc123" });
        }
        return jsonResponse(404, {});
      }),
    );

    renderApp("/");

    // Confirms window.location.search was actually read: the identify flow
    // only ever starts when isCallback is true, which requires exactly this.
    await waitFor(() => expect(screen.getByText("user_abc123")).toBeInTheDocument());

    // Confirms the app navigated somewhere the result is visible, rather
    // than stranding it on the (now hash-less) landing route.
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
  });

  it("OAuth callback: an invalid/missing pending sign-in shows the existing fatal_error message, not a crash", async () => {
    seedKnoveraSession();
    // No sessionConfig saved at all — loadConfig() returns null.
    window.history.pushState({}, "", "/?code=auth_code_abc&state=whatever");
    renderApp("/");
    await waitFor(() =>
      expect(screen.getByText(/Returned from Whop but no pending sign-in was found for this session/)).toBeInTheDocument(),
    );
  });
});

describe("App — Phase 4D Knovera login/logout", () => {
  beforeEach(() => {
    import.meta.env.VITE_WHOP_CLIENT_ID = "test_client_id";
    (import.meta.env as { VITE_BACKEND_URL?: string }).VITE_BACKEND_URL = "https://backend.example.com";
    sessionStorage.clear();
    window.history.pushState({}, "", "/login");
  });

  afterEach(() => {
    import.meta.env.VITE_WHOP_CLIENT_ID = ORIGINAL_CLIENT_ID;
    (import.meta.env as { VITE_BACKEND_URL?: string }).VITE_BACKEND_URL = ORIGINAL_BACKEND_URL;
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("a successful login navigates from the Knovera login screen to Projects and persists the token to sessionStorage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/knovera-auth/login")) return jsonResponse(200, { token: "fresh-knovera-token", expiresIn: 43200 });
        if (url.endsWith("/api/knovera-auth/me")) {
          expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer fresh-knovera-token");
          return jsonResponse(200, { authenticated: true, email: "operator@example.com" });
        }
        return jsonResponse(404, {});
      }),
    );

    renderApp("/login");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "operator@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument());
    expect(sessionStorage.getItem(KNOVERA_TOKEN_STORAGE_KEY)).toBe("fresh-knovera-token");
  });

  it("an invalid login shows a generic error and does not navigate away from /login", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));

    renderApp("/login");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "operator@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password."));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(sessionStorage.getItem(KNOVERA_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("a stored session token that the backend no longer accepts (expired/tampered) is cleared and the operator is sent back to /login", async () => {
    seedKnoveraSession("stale-token");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, {})));

    window.history.pushState({}, "", "/projects");
    renderApp("/projects");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(sessionStorage.getItem(KNOVERA_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("a stored session token the backend still accepts restores the session on reload without re-prompting for login", async () => {
    seedKnoveraSession("still-valid-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/knovera-auth/me")) return jsonResponse(200, { authenticated: true, email: "operator@example.com" });
        return jsonResponse(404, {});
      }),
    );

    window.history.pushState({}, "", "/projects");
    renderApp("/projects");

    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    await waitFor(() => expect(sessionStorage.getItem(KNOVERA_TOKEN_STORAGE_KEY)).toBe("still-valid-token"));
  });

  it("logging out clears the Knovera session and returns to /login, without requiring Whop to have ever been connected", async () => {
    seedKnoveraSession("logout-me-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/knovera-auth/me")) return jsonResponse(200, { authenticated: true, email: "operator@example.com" });
        if (url.endsWith("/api/knovera-auth/logout")) return jsonResponse(200, {});
        return jsonResponse(404, {});
      }),
    );

    window.history.pushState({}, "", "/projects");
    renderApp("/projects");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await waitFor(() => expect(screen.getByText("operator@example.com")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(sessionStorage.getItem(KNOVERA_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
