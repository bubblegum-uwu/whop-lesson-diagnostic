import { StrictMode } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LinkDiscordPage } from "../LinkDiscordPage";
import { takePendingDiscordLinkToken } from "../../lib/discordLinkPending";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage(path: string, knoveraToken: string | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/link-discord" element={<LinkDiscordPage backendUrl="https://backend.example.com" knoveraToken={knoveraToken} />} />
        <Route path="/login" element={<div>LOGIN_MARKER</div>} />
        <Route path="/projects" element={<div>PROJECTS_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The real app renders under <StrictMode> (see main.tsx) — this reproduces its dev-only double-invoke-effects behavior, which is exactly what exposed the double-consume bug (Fix 6). */
function renderPageStrict(path: string, knoveraToken: string | null) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/link-discord" element={<LinkDiscordPage backendUrl="https://backend.example.com" knoveraToken={knoveraToken} />} />
          <Route path="/login" element={<div>LOGIN_MARKER</div>} />
          <Route path="/projects" element={<div>PROJECTS_MARKER</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("LinkDiscordPage", () => {
  it("when signed in, consumes the token and shows success", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://backend.example.com/api/discord/link");
      expect(JSON.parse(init.body as string)).toEqual({ token: "tok-abc" });
      return jsonResponse(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage("/link-discord?token=tok-abc", "knovera-token");

    await waitFor(() => expect(screen.getByText(/linked to Knovera/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the backend's exact error message for an invalid/expired token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, { error: { message: "This link is invalid, expired, or has already been used.", type: "invalid_link_token" } }),
      ),
    );

    renderPage("/link-discord?token=tok-bad", "knovera-token");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/invalid, expired/));
  });

  it("when NOT signed in, stashes the token and redirects to /login without ever calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPage("/link-discord?token=tok-xyz", null);

    await waitFor(() => expect(screen.getByText("LOGIN_MARKER")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(takePendingDiscordLinkToken()).toBe("tok-xyz");
  });

  it("a missing token shows an error without calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPage("/link-discord", "knovera-token");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/missing its token/));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Live-validation Fix 6 — under the real app's <StrictMode> (see
  // main.tsx), React deliberately mounts, cleans up, and remounts this
  // component's effects once in dev, to surface exactly this class of bug.
  // A one-time backend token consumed twice for the same page load
  // previously showed the SECOND (always-failing, "already used") response
  // instead of the first's real success — the fix guards consumption with
  // a ref so it is attempted at most once per mounted page, regardless of
  // how many times StrictMode re-invokes the effect.
  it("under StrictMode's double-invoked effects, the consume endpoint is called only once and the page shows success (not a false 'already used' error)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    renderPageStrict("/link-discord?token=tok-strict", "knovera-token");

    await waitFor(() => expect(screen.getByText(/linked to Knovera/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("under StrictMode, a SECOND distinct token on a fresh mount is still consumed normally (the guard is per-mount, not permanent)", async () => {
    const seenTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seenTokens.push((JSON.parse(init.body as string) as { token: string }).token);
        return jsonResponse(200, { ok: true });
      }),
    );

    const first = renderPageStrict("/link-discord?token=tok-one", "knovera-token");
    await waitFor(() => expect(screen.getByText(/linked to Knovera/)).toBeInTheDocument());
    first.unmount();

    renderPageStrict("/link-discord?token=tok-two", "knovera-token");
    await waitFor(() => expect(screen.getByText(/linked to Knovera/)).toBeInTheDocument());

    // Each token consumed exactly once (StrictMode's double-invoke
    // collapsed to one real call per mount), never once per token overall
    // being skipped or merged.
    expect(seenTokens).toEqual(["tok-one", "tok-two"]);
  });
});
