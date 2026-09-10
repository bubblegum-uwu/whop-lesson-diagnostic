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

const YOUTUBE_SOURCE = {
  provider: "YOUTUBE",
  sourceType: "VIDEO",
  id: 1,
  externalId: "dQw4w9WgXcQ",
  sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Support & Resistance Basics",
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
  return { sourceId: 1, job: null, analysis: null, ...overrides };
}

describe("SourcesPage — project-source (YouTube) analysis actions (Phase 4H-B)", () => {
  it("A/C: clicking Analyze calls POST .../sources/:sourceId/analyze", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson());
      if (url === "https://backend.example.com/api/projects/7/sources/1/analyze" && init?.method === "POST") {
        expect(JSON.parse(init!.body as string)).toEqual({ force: false });
        return jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://backend.example.com/api/projects/7/sources/1/analyze",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("D: Whop disconnected does not disable the Analyze button", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson());
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources", { connected: false });
    await waitFor(() => expect(screen.getByText("Not Connected")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
  });

  it("E: a QUEUED job shows the Queued status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } }));
        }
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
  });

  it("F: an ANALYZING job shows the Analyzing status (a processing state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "ANALYZING", attemptCount: 1, sanitizedError: null } }));
        }
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Analyzing")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Analyze" })).not.toBeInTheDocument();
  });

  it("G/I/J: an analyzed source exposes View, and View displays the persisted analysis under a YouTube Video identity", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 1,
      status: "completed",
      strategyFound: true,
      validatedJson: {
        lesson: { title: "Support & Resistance Basics", duration_seconds: null },
        strategy_found: true,
        strategies: [
          {
            strategy_name: "Break & Retest",
            market_or_instrument: ["ES"],
            timeframes: ["5m"],
            entry_rules: [{ description: "retest entry", start_timestamp: "00:15", end_timestamp: null, evidence: "shown on chart" }],
          },
        ],
        knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] },
      },
      analysisSummary: "Break & Retest using VWAP",
      processingDurationSeconds: 30,
      inputTokens: 100,
      outputTokens: 20,
      thinkingTokens: 0,
      estimatedCost: 0.05,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "COMPLETED", attemptCount: 1, sanitizedError: null }, analysis }));
        }
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("YouTube Video").length).toBeGreaterThan(0);
    expect(screen.getByText("Break & Retest")).toBeInTheDocument();
    expect(screen.getByText("retest entry")).toBeInTheDocument();
    // Never a fake Whop lesson/course identity.
    expect(screen.queryByText(/Whop lesson/i)).not.toBeInTheDocument();
  });

  it("H: a FAILED job exposes Retry with the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
        if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") {
          return jsonResponse(200, analysisJson({ job: { jobId: "job-1", projectSourceId: 1, status: "FAILED", attemptCount: 1, sanitizedError: "Video unavailable." } }));
        }
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("L: Re-analyze on an analyzed source calls analyze with force:true", async () => {
    const analysis = {
      analysisId: 1,
      projectSourceId: 1,
      status: "no_strategy",
      strategyFound: false,
      validatedJson: { lesson: { title: "x", duration_seconds: null }, strategy_found: false, strategies: [], knowledge: { summary: "", knowledgeItems: [], examples: [], conflictsAndAmbiguities: [] } },
      analysisSummary: "summary",
      processingDurationSeconds: 10,
      inputTokens: 1,
      outputTokens: 1,
      thinkingTokens: 0,
      estimatedCost: 0.01,
      completedAt: "2026-01-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [YOUTUBE_SOURCE] });
      if (url === "https://backend.example.com/api/projects/7/sources/1/analysis") return jsonResponse(200, analysisJson({ analysis }));
      if (url === "https://backend.example.com/api/projects/7/sources/1/analyze" && init?.method === "POST") {
        expect(JSON.parse(init!.body as string)).toEqual({ force: true });
        return jsonResponse(202, { alreadyQueued: false, job: { jobId: "job-2", projectSourceId: 1, status: "QUEUED", attemptCount: 1, sanitizedError: null } });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Re-analyze" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Re-analyze" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://backend.example.com/api/projects/7/sources/1/analyze",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
