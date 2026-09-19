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
    connected: true,
    providerErrorMessage: null,
    onSignIn: () => {},
    onDisconnect: () => {},
    backendUrl: "https://backend.example.com",
    knoveraToken: "token",
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
    await waitFor(() => expect(screen.getByText(/1 course connected — lessons synced and analyzed via Whop\./)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "The Trading Accelerator" })).toBeInTheDocument();
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

  it("E/C: a valid project with no sources shows the empty-source state with accurate copy, offering all three real providers (Phase 4I: Discord is functional too, never a stale 'coming soon' promise)", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources", { connected: false });

    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.getByText("Not Connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Whop, add a YouTube video, or add a Discord video to add content.")).toBeInTheDocument();
  });

  it("F/G/H: YouTube and Discord are both functional (Add YouTube Video / Add Discord Video); Whop shows Not Connected (signed out, no live Whop connection) before its source is resolved", () => {
    renderSources("/projects/mastermind/sources", { backendUrl: null, knoveraToken: null, connected: false });
    expect(screen.queryByText("Coming Soon")).not.toBeInTheDocument();
    expect(screen.getByText("Not Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Discord Video" })).toBeInTheDocument();
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

  it("K: a project with no source never shows a Whop Courses section or any lesson-management controls", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Whop Courses" })).not.toBeInTheDocument();
    expect(screen.queryByText("Analyze All Unanalyzed")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("M/G: the Whop Courses card and provider-level Disconnect Whop remain visible for MasterMind (a project that does own a source) — no full lesson dashboard alongside them", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/7/sources", { connected: true });

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { name: "Whop Courses" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "The Trading Accelerator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect Whop" })).toBeInTheDocument();
    // No full lesson dashboard/table on this page anymore (Phase 4K follow-up).
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Analyze All Unanalyzed")).not.toBeInTheDocument();
  });

  it("never renders the legacy Diagnostic Tools disclosure (single-lesson diagnostic / find-my-user-id), for a project with sources, without sources, or pre-auth", async () => {
    stubFetch([WHOP_SOURCE]);
    renderSources("/projects/7/sources", { connected: true });

    await waitFor(() => expect(screen.getByRole("heading", { name: "The Trading Accelerator" })).toBeInTheDocument());
    expect(screen.queryByText("Diagnostic Tools")).not.toBeInTheDocument();
    expect(screen.queryByText("First-time setup: find my Whop user ID")).not.toBeInTheDocument();
    expect(screen.queryByText("Whop Lesson Media Diagnostic")).not.toBeInTheDocument();

    // Same for a confirmed-empty project…
    stubFetch([]);
    const { unmount } = renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByText("Diagnostic Tools")).not.toBeInTheDocument();
    unmount();

    // …and pre-auth (signed out of Knovera never had a diagnostic-tools escape hatch to lose).
    renderSources("/projects/mastermind/sources", { backendUrl: "https://backend.example.com", knoveraToken: null });
    expect(screen.queryByText("Diagnostic Tools")).not.toBeInTheDocument();
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

    renderSources("/projects/8/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "SecondProject" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No sources connected yet.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "The Trading Accelerator" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Whop Courses" })).not.toBeInTheDocument();
  });

  it("preserves the pre-auth 'Connect Whop' entry point when signed out, gated on nothing but live connection state", () => {
    renderSources("/projects/mastermind/sources", { backendUrl: "https://backend.example.com", knoveraToken: null, connected: false });
    expect(screen.getByRole("button", { name: "Connect Whop" })).toBeInTheDocument();
  });
});

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
  collectionId: null,
};

describe("SourcesPage — YouTube project sources (Phase 4H-A)", () => {
  it("A: the YouTube provider card shows Add YouTube Video instead of Coming Soon", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeInTheDocument());
  });

  it("B/C: clicking Add YouTube Video opens the dialog with a URL field", async () => {
    stubFetch([]);
    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));

    expect(screen.getByRole("dialog", { name: "Add YouTube Video" })).toBeInTheDocument();
    expect(screen.getByLabelText("YouTube URL")).toBeInTheDocument();
  });

  it("F/G/H: a successful add closes the dialog, refreshes the sources list, and renders the new YouTube source", async () => {
    let sourcesCallCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources/youtube" && init?.method === "POST") {
        return jsonResponse(201, { source: YOUTUBE_SOURCE, duplicate: false });
      }
      if (url === "https://backend.example.com/api/projects/7/sources") {
        sourcesCallCount += 1;
        return jsonResponse(200, { projectId: 7, sources: sourcesCallCount === 1 ? [] : [YOUTUBE_SOURCE] });
      }
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add YouTube Video" })).not.toBeInTheDocument());
    // Phase 4L taxonomy correction — the main Sources page is
    // collection/group-only, driven entirely by GET /collections, never by
    // the raw /sources list (see CollectionDetailPage.tsx and the
    // taxonomy-correction group model) — this only verifies the dialog
    // closed and the sources list was refreshed.
    await waitFor(() => expect(sourcesCallCount).toBeGreaterThanOrEqual(2));
  });

  it("K: no fake Whop lesson-table controls (Sync Course/lesson counts) appear for a YouTube-only source, even though real per-source Analyze status now does (Phase 4H-B)", async () => {
    stubFetch([YOUTUBE_SOURCE]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.queryByText("Sync Course")).not.toBeInTheDocument());
    expect(screen.queryByText("Analyze All Unanalyzed")).not.toBeInTheDocument();
    expect(screen.queryByText(/lessons? analyzed/i)).not.toBeInTheDocument();
  });

  it("a YouTube-only project (no Whop course) does not show the empty-state box or a Whop Courses section", async () => {
    stubFetch([YOUTUBE_SOURCE]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.queryByText("No sources connected yet.")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Whop Courses" })).not.toBeInTheDocument();
  });

  it("I: adding a YouTube video works while Whop is disconnected (no live Whop connection)", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects: [MASTERMIND_API_PROJECT] });
      if (url === "https://backend.example.com/api/projects/7/sources/youtube" && init?.method === "POST") {
        return jsonResponse(201, { source: YOUTUBE_SOURCE, duplicate: false });
      }
      if (url === "https://backend.example.com/api/projects/7/sources") return jsonResponse(200, { projectId: 7, sources: [] });
      return jsonResponse(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    renderSources("/projects/7/sources", { connected: false });
    await waitFor(() => expect(screen.getByText("Not Connected")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add YouTube Video" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Add YouTube Video" }));
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Video" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://backend.example.com/api/projects/7/sources/youtube",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("N: YouTube and Whop sources both render together from one coherent GET /sources response", async () => {
    stubFetch([WHOP_SOURCE, YOUTUBE_SOURCE]);
    renderSources("/projects/7/sources");

    await waitFor(() => expect(screen.getByRole("heading", { name: "The Trading Accelerator" })).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText("Loading sources…")).not.toBeInTheDocument());
  });
});
