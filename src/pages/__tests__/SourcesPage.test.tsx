import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  courseCount: 1,
  lessonCount: 28,
  analyzedLessonCount: 28,
  latestSynthesisStatus: "COMPLETED",
  latestSynthesisCompletedAt: "2026-01-02T00:00:00.000Z",
};

const WHOP_SOURCE = {
  provider: "WHOP",
  sourceType: "COURSE",
  courseId: 3,
  externalId: "cors_4lb7N3oassoZwHJvrufOYy",
  name: "The Trading Accelerator",
  lessonCount: 28,
  analyzedLessonCount: 25,
  queuedCount: 1,
  processingCount: 0,
  failedCount: 2,
  remainingCount: 0,
  lastSyncedAt: "2026-01-02T00:00:00.000Z",
  totalCost: 4.5,
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

function stubFetch(sources: unknown[] | "error", projects: unknown[] = [MASTERMIND_API_PROJECT]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects });
      if (url.endsWith("/sources")) {
        return sources === "error" ? jsonResponse(500, { error: { message: "Sources unavailable." } }) : jsonResponse(200, { projectId: 7, sources });
      }
      return jsonResponse(404, {});
    }),
  );
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

describe("SourcesPage — project-aware sources (Phase 4C)", () => {
  it("A: loads this project's sources from GET /api/projects/:projectId/sources", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [WHOP_SOURCE] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://backend.example.com/api/projects/7/sources", expect.anything()));
  });

  it("B: renders the real connected Whop source (name, Connected badge)", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.getByText(/The Trading Accelerator — course lessons, synced and analyzed via Whop\./)).toBeInTheDocument();
  });

  it("C: shows a loading state while the sources fetch is in flight", async () => {
    let resolveSources!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
        if (url.endsWith("/sources")) return new Promise<Response>((resolve) => (resolveSources = resolve));
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByText("Loading sources…")).toBeInTheDocument());
    resolveSources(jsonResponse(200, { projectId: 7, sources: [WHOP_SOURCE] }));
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
  });

  it("D: shows a backend error state when the sources fetch fails", async () => {
    stubFetch("error");
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("Sources unavailable.")).toBeInTheDocument());
  });

  it("E/C: a valid project with no sources shows the empty-source state with accurate copy, not fabricated data or a promise about YouTube/Discord being connectable now", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources", { connected: false });

    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.getByText("Not Connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Whop to add content. YouTube and Discord support are coming soon.")).toBeInTheDocument();
    expect(screen.queryByText(/Connect Whop, YouTube, or Discord/)).not.toBeInTheDocument();
  });

  it("F/G/H: YouTube and Discord show Coming Soon; Whop shows Not Connected (signed out, no live Whop connection) before its source is resolved", () => {
    renderSources("/projects/mastermind/sources", { backendUrl: null, knoveraToken: null, connected: false });
    expect(screen.getAllByText("Coming Soon")).toHaveLength(2);
    expect(screen.getByText("Not Connected")).toBeInTheDocument();
  });

  it("I: a real numeric project id route (from the mocked API) works end to end", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/projects/7/sources");
  });

  it("J: the legacy /projects/mastermind/sources route still works once the real project resolves", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/mastermind/sources");
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
  });

  it("K: a project with no source never shows the Trading Accelerator course table", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources", { courseTitle: "The Trading Accelerator" });

    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByText("Sync Course")).not.toBeInTheDocument();
    expect(screen.queryByText("Analyze All Unanalyzed")).not.toBeInTheDocument();
  });

  it("M/G: existing lesson-management AND Diagnostic Tools remain functional/visible for MasterMind (a project that does own a source)", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/7/sources", { connected: true });

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.getByText("Sync Course")).toBeInTheDocument();
    expect(screen.getByText("Disconnect Whop")).toBeInTheDocument();
    expect(screen.getByText("Diagnostic Tools")).toBeInTheDocument();
  });

  it("D: a confirmed-empty project hides Diagnostic Tools (legacy Whop-only utilities with nothing to operate on)", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByText("Diagnostic Tools")).not.toBeInTheDocument();
  });

  it("Diagnostic Tools stays visible pre-auth (it's still how a signed-out visitor can sign in / use the standalone diagnostic), not hidden by an unresolvable sources check", () => {
    renderSources("/projects/mastermind/sources", { backendUrl: "https://backend.example.com", knoveraToken: null });
    expect(screen.getByText("Diagnostic Tools")).toBeInTheDocument();
  });

  it("N: a project route does not leak another project's course into the Sources workspace", async () => {
    const projectA = { ...MASTERMIND_API_PROJECT, id: 7, name: "MasterMind" };
    const projectB = { ...MASTERMIND_API_PROJECT, id: 8, name: "SecondProject" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [projectA, projectB] });
        if (url === "https://backend.example.com/api/projects/8/sources") return jsonResponse(200, { projectId: 8, sources: [] });
        if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [WHOP_SOURCE] });
        return jsonResponse(404, {});
      }),
    );

    renderSources("/projects/8/sources", { courseTitle: "The Trading Accelerator" });

    await waitFor(() => expect(screen.getByRole("heading", { name: "SecondProject" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByText(/The Trading Accelerator — course lessons/)).not.toBeInTheDocument();
    expect(screen.queryByText("Sync Course")).not.toBeInTheDocument();
  });

  it("preserves the pre-auth 'Connect Whop' entry point when signed out (CourseTable is the primary sign-in surface, not gated on an unresolvable sources check)", () => {
    renderSources("/projects/mastermind/sources", { backendUrl: "https://backend.example.com", knoveraToken: null, connected: false });
    // Two "Connect Whop" entry points now legitimately coexist while signed
    // out: the Phase 4D provider-card button (shown whenever Whop isn't
    // live-connected) and CourseTable's own pre-existing sign-in button.
    expect(screen.getAllByText("Connect Whop").length).toBeGreaterThanOrEqual(1);
  });
});
