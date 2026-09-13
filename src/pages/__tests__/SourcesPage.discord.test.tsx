import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MASTERMIND_API_PROJECT = {
  id: 7,
  name: "MasterMind",
  projectType: "TRADING_STRATEGIES",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseCount: 0,
  lessonCount: 0,
  analyzedLessonCount: 0,
  latestSynthesisStatus: null,
  latestSynthesisCompletedAt: null,
};

const DISCORD_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

const DISCORD_SOURCE = {
  provider: "DISCORD",
  sourceType: "VIDEO",
  id: 5,
  externalId: "987654321098765432",
  sourceUrl: DISCORD_URL,
  title: "Trade Recap Clip",
  durationSeconds: null,
  status: "READY",
  createdAt: "2026-01-05T00:00:00.000Z",
  collectionId: null,
};

function baseProps(overrides: Partial<SourcesPageProps> = {}): SourcesPageProps {
  return {
    courseTitle: null,
    lessons: [],
    connected: true,
    syncing: false,
    authRequired: false,
    lastSyncedAt: null,
    summary: null,
    courseErrorMessage: null,
    onSignIn: () => {},
    onSync: () => {},
    onDisconnect: () => {},
    onEnqueue: () => {},
    onRetry: () => {},
    onCancel: () => {},
    onLoadAnalysis: async () => null,
    identifyState: { phase: "idle" },
    onFindUserId: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
    diagnosticState: { phase: "config", errorMessage: null, submitting: false },
    redirectUri: "https://example.com/",
    onDiagnosticSubmit: () => {},
    onDiagnosticReset: () => {},
    ...overrides,
  };
}

function renderSources(initialPath: string, props: Partial<SourcesPageProps> = {}) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseProps(props)} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function analysisJson(overrides: Record<string, unknown> = {}) {
  return { sourceId: 5, job: null, analysis: null, ...overrides };
}

describe("SourcesPage — Discord project sources (Phase 4I)", () => {
  it("B/C: clicking Add Discord Video opens the dialog with an attachment URL field", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Discord Video" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add Discord Video" }));

    expect(screen.getByRole("dialog", { name: "Add Discord Video" })).toBeInTheDocument();
    expect(screen.getByLabelText("Discord Attachment URL")).toBeInTheDocument();
  });

  it("a successful add closes the dialog, refreshes the sources list, and renders the new Discord source under a 'Discord Video' label", async () => {
    let sourcesCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources/discord" && init?.method === "POST") {
        expect(JSON.parse(init!.body as string)).toEqual({ url: DISCORD_URL });
        return jsonResponse(201, { source: DISCORD_SOURCE, duplicate: false });
      }
      if (url === "https://backend.example.com/api/projects/7/sources") {
        sourcesCallCount += 1;
        return jsonResponse(200, { projectId: 7, sources: sourcesCallCount === 1 ? [] : [DISCORD_SOURCE] });
      }
      if (url === "https://backend.example.com/api/projects/7/sources/5/analysis") return jsonResponse(200, analysisJson());
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Discord Video" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add Discord Video" }));
    fireEvent.change(screen.getByLabelText("Discord Attachment URL"), { target: { value: DISCORD_URL } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Discord Video" })).not.toBeInTheDocument());
    // Phase 4L follow-up — the main Sources page is collection-only: the
    // newly-added source never renders as a row here (see
    // UncollectedSourcesDetailPage.tsx for the per-row Discord Video
    // identity/analysis behavior), only the virtual card's count.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Uncollected Sources" })).toBeInTheDocument());
    expect(screen.getByText(/À-la-carte · 1 item/)).toBeInTheDocument();
  });

  it("a malformed Discord URL is rejected client-side (never reaches the network) with the parser's own message", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Discord Video" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add Discord Video" }));
    fireEvent.change(screen.getByLabelText("Discord Attachment URL"), { target: { value: "https://example.com/not-discord.mp4" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/discord/i);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/sources/discord"), expect.anything());
  });

  it("M: existing Whop Sources UI and YouTube provider card remain unchanged alongside the new Discord card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "YouTube" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Discord" })).toBeInTheDocument();
  });
});
