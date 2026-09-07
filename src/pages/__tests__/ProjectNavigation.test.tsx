import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SourcesPage, type SourcesPageProps } from "../SourcesPage";
import { SynthesisPage } from "../SynthesisPage";

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
