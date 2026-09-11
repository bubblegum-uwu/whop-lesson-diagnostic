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
    await waitFor(() => expect(screen.getByText("Trade Recap Clip")).toBeInTheDocument());
    expect(screen.getByText("Discord Video")).toBeInTheDocument();
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

  it("A: a Discord source with no analysis job shows 'Not analyzed' and an Analyze button — the same generic logic as YouTube", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/5/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Not analyzed")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument();
  });

  it("J: Whop disconnected does not disable Analyze for a Discord source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/5/analysis") return jsonResponse(200, analysisJson());
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources", { connected: false });
    await waitFor(() => expect(screen.getByText("Not Connected")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
  });

  it("K: no Analyze/View/Retry controls appear for a Discord source in a General Knowledge project", async () => {
    const gkProject = { ...MASTERMIND_API_PROJECT, id: 8, name: "GK Project", projectType: "GENERAL_KNOWLEDGE" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [gkProject] });
        if (url === "https://backend.example.com/api/projects/8/sources") return jsonResponse(200, { projectId: 8, sources: [DISCORD_SOURCE] });
        return jsonResponse(404, {});
      }),
    );
    renderSources("/projects/8/sources");
    await waitFor(() => expect(screen.getByText("Trade Recap Clip")).toBeInTheDocument());

    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analyze" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not analyzed")).not.toBeInTheDocument();
  });

  it("H/I: View on a completed Discord analysis opens the drawer under a 'Discord Video' identity with an 'Open Attachment' link, never a fake Whop lesson or YouTube label", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 5,
      status: "completed",
      strategyFound: true,
      validatedJson: {
        lesson: { title: "Trade Recap Clip", duration_seconds: null },
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: [],
            timeframes: [],
            entry_rules: [{ description: "retest entry", start_timestamp: "00:15", end_timestamp: null, evidence: "shown on screen" }],
          },
        ],
        knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
      },
      analysisSummary: "Break & Retest",
      processingDurationSeconds: 20,
      inputTokens: 10,
      outputTokens: 5,
      thinkingTokens: 0,
      estimatedCost: 0.02,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [DISCORD_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/5/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 5, status: "COMPLETED", attemptCount: 1, sanitizedError: null }, analysis }));
        }
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Discord Video").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open Attachment" })).toHaveAttribute("href", DISCORD_URL);
    expect(screen.queryByText("YouTube Video")).not.toBeInTheDocument();
    expect(screen.queryByText(/Whop lesson/i)).not.toBeInTheDocument();
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
