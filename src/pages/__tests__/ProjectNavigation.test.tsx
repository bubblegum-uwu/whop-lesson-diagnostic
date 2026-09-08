import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";
import { SynthesisPage } from "../SynthesisPage";
import { ProjectsPage } from "../ProjectsPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseSourcesProps(): SourcesPageProps {
  return {
    courseTitle: null,
    lessons: [],
    connected: false,
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
    backendUrl: null,
    accessToken: null,
    diagnosticState: { phase: "config", errorMessage: null, submitting: false },
    redirectUri: "https://example.com/",
    onDiagnosticSubmit: () => {},
    onDiagnosticReset: () => {},
  };
}

function renderProjectWorkspace(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/projects/:projectId/sources" element={<SourcesPage {...baseSourcesProps()} />} />
        <Route path="/projects/:projectId/synthesis" element={<SynthesisPage backendUrl={null} accessToken={null} connected={false} />} />
        <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Project workspace navigation", () => {
  it("shows the project header (name + type) and Sources/Synthesis tabs on the Sources page", () => {
    renderProjectWorkspace("/projects/mastermind/sources");
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sources" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Synthesis" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "← Projects" })).toBeInTheDocument();
  });

  it("lists Whop (operational), YouTube (Coming Soon), and Discord (Coming Soon) as source providers", () => {
    renderProjectWorkspace("/projects/mastermind/sources");
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "YouTube" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Discord" })).toBeInTheDocument();
    expect(screen.getAllByText("Coming Soon")).toHaveLength(2);
  });

  it("clicking the Synthesis tab from Sources navigates to the Synthesis page", () => {
    renderProjectWorkspace("/projects/mastermind/sources");
    fireEvent.click(screen.getByRole("link", { name: "Synthesis" }));
    // Header persists (same project), and we're now on the synthesis route —
    // confirmed by the Sources tab being present again (round-trip capable).
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sources" })).toBeInTheDocument();
  });

  it("clicking the Sources tab from Synthesis navigates back to Sources", () => {
    renderProjectWorkspace("/projects/mastermind/synthesis");
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Sources" }));
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
  });

  it("clicking ← Projects returns to the Projects page", () => {
    renderProjectWorkspace("/projects/mastermind/sources");
    fireEvent.click(screen.getByRole("link", { name: "← Projects" }));
    expect(screen.getByText("PROJECTS_PAGE_MARKER")).toBeInTheDocument();
  });

  it("an unknown projectId redirects to /projects instead of rendering a broken page", () => {
    renderProjectWorkspace("/projects/does-not-exist/sources");
    expect(screen.getByText("PROJECTS_PAGE_MARKER")).toBeInTheDocument();
  });
});

describe("Project workspace navigation — backed by GET /api/projects", () => {
  it("the project header renders the real fetched project's name/type, and links use its real numeric id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/projects")) {
          return jsonResponse(200, {
            projects: [
              {
                id: 42,
                name: "MasterMind",
                projectType: "TRADING_STRATEGIES",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                courseCount: 1,
                lessonCount: 28,
                analyzedLessonCount: 28,
                latestSynthesisStatus: null,
                latestSynthesisCompletedAt: null,
              },
            ],
          });
        }
        return jsonResponse(404, {});
      }),
    );

    render(
      <MemoryRouter initialEntries={["/projects/mastermind/sources"]}>
        <Routes>
          <Route
            path="/projects/:projectId/sources"
            element={<SourcesPage {...baseSourcesProps()} backendUrl="https://backend.example.com" accessToken="token" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/projects/42/sources"));
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Synthesis" })).toHaveAttribute("href", "/projects/42/synthesis");
  });
});

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

function stubProjectsFetch(projects: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) return jsonResponse(200, { projects });
      return jsonResponse(404, {});
    }),
  );
}

/**
 * Regression coverage for the Phase 4B hotfix: ProjectHeader used to redirect
 * to /projects on the very first (pre-fetch) render for ANY route param that
 * wasn't the legacy "mastermind" slug — including a perfectly real numeric id
 * from GET /api/projects — because its initial "unresolved" state was treated
 * as "definitely not found" before the async lookup had even started. That
 * made clicking "Open" on a backend-loaded project bounce straight back to
 * the Projects page.
 */
describe("Phase 4B hotfix — Open no longer bounces back to Projects", () => {
  it("clicking Open on the backend-loaded MasterMind card navigates to /projects/<id>/sources and STAYS there", async () => {
    stubProjectsFetch([MASTERMIND_API_PROJECT]);

    render(
      <MemoryRouter initialEntries={["/projects"]}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage backendUrl="https://backend.example.com" accessToken="token" />} />
          <Route
            path="/projects/:projectId/sources"
            element={<SourcesPage {...baseSourcesProps()} backendUrl="https://backend.example.com" accessToken="token" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));

    // Must land on, and stay on, the Sources workspace — never bounce back to Projects.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument());
    expect(screen.queryByText("Loading projects…")).not.toBeInTheDocument();

    // The header's own async lookup resolves afterwards; confirm it settles on the
    // real id and the page is still the Sources workspace once it does (no later bounce).
    await waitFor(() => expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/projects/7/sources"));
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
  });

  it("direct navigation to /projects/<id>/sources with a real numeric id resolves and stays (does not require arriving via Open)", async () => {
    stubProjectsFetch([MASTERMIND_API_PROJECT]);

    render(
      <MemoryRouter initialEntries={["/projects/7/sources"]}>
        <Routes>
          <Route
            path="/projects/:projectId/sources"
            element={<SourcesPage {...baseSourcesProps()} backendUrl="https://backend.example.com" accessToken="token" />}
          />
          <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Never bounces to /projects, even before the fetch resolves.
    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Whop" })).toBeInTheDocument();
    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
  });

  it("direct navigation to /projects/<id>/synthesis with a real numeric id resolves and stays", async () => {
    stubProjectsFetch([MASTERMIND_API_PROJECT]);

    render(
      <MemoryRouter initialEntries={["/projects/7/synthesis"]}>
        <Routes>
          <Route
            path="/projects/:projectId/synthesis"
            element={<SynthesisPage backendUrl="https://backend.example.com" accessToken="token" connected={false} />}
          />
          <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Synthesis" })).toHaveAttribute("href", "/projects/7/synthesis");
    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
  });

  it("legacy /projects/mastermind/sources keeps working once the real project resolves", async () => {
    stubProjectsFetch([MASTERMIND_API_PROJECT]);

    render(
      <MemoryRouter initialEntries={["/projects/mastermind/sources"]}>
        <Routes>
          <Route
            path="/projects/:projectId/sources"
            element={<SourcesPage {...baseSourcesProps()} backendUrl="https://backend.example.com" accessToken="token" />}
          />
          <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "/projects/7/sources"));
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
  });

  it("a numeric id that GET /api/projects does not return still redirects to /projects — but only after the lookup completes, not immediately", async () => {
    stubProjectsFetch([MASTERMIND_API_PROJECT]);

    render(
      <MemoryRouter initialEntries={["/projects/999/sources"]}>
        <Routes>
          <Route
            path="/projects/:projectId/sources"
            element={<SourcesPage {...baseSourcesProps()} backendUrl="https://backend.example.com" accessToken="token" />}
          />
          <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
        </Routes>
      </MemoryRouter>,
    );

    // Not an immediate bounce — the plausible-looking numeric id waits for the lookup.
    expect(screen.queryByText("PROJECTS_PAGE_MARKER")).not.toBeInTheDocument();
    // Once the lookup completes and finds no match, it does redirect.
    await waitFor(() => expect(screen.getByText("PROJECTS_PAGE_MARKER")).toBeInTheDocument());
  });
});
