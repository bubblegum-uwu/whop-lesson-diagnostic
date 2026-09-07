import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "../App";

const ORIGINAL_CLIENT_ID = import.meta.env.VITE_WHOP_CLIENT_ID;

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

  it("renders the Projects page directly at /projects", () => {
    renderApp("/projects");
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
  });

  it("renders the Sources workspace directly at /projects/mastermind/sources (refreshable hash route)", () => {
    renderApp("/projects/mastermind/sources");
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
  });

  it("renders the Usage page directly at /usage", () => {
    renderApp("/usage");
    expect(screen.getByText("Usage & Spend")).toBeInTheDocument();
  });

  /**
   * Phase 4A — the Whop OAuth callback logic (App.tsx's useEffect reading
   * window.location.search, parseCallbackParams, exchangeCodeForTokens,
   * clearConfig) is completely untouched by routing. This exercises the
   * "identify" flow (find-my-Whop-user-id) end to end through the REAL
   * window.location.search — HashRouter/MemoryRouter never touch
   * location.search, only location.hash, so this must keep working exactly
   * as it did on the pre-Phase-4 single-page app.
   */
  it("OAuth callback: reads window.location.search, completes the identify flow, and resumes on the Sources page (Diagnostic Tools) where the result is now visible", async () => {
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
    // No sessionConfig saved at all — loadConfig() returns null.
    window.history.pushState({}, "", "/?code=auth_code_abc&state=whatever");
    renderApp("/");
    await waitFor(() =>
      expect(screen.getByText(/Returned from Whop but no pending sign-in was found for this session/)).toBeInTheDocument(),
    );
  });
});
