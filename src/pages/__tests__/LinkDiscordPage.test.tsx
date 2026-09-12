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
});
