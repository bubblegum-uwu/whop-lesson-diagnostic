import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectsPage, type ProjectsPageProps } from "../ProjectsPage";
import type { ProjectSummary } from "../../lib/projectsApi";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const MASTERMIND: ProjectSummary = {
  id: 1,
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

function stubFetch(projects: ProjectSummary[] | "error") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/projects")) {
        return projects === "error" ? jsonResponse(500, { error: { message: "Database unavailable." } }) : jsonResponse(200, { projects });
      }
      return jsonResponse(404, {});
    }),
  );
}

function renderProjects(props: Partial<ProjectsPageProps> = {}) {
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage backendUrl="https://backend.example.com" accessToken="token" {...props} />} />
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectsPage", () => {
  it("prompts sign-in when there is no access token yet, rather than fetching or fabricating data", () => {
    renderProjects({ accessToken: null });
    expect(screen.getByText("Sign in to view your projects.")).toBeInTheDocument();
  });

  it("shows a loading state while GET /api/projects is in flight", async () => {
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );
    renderProjects();
    expect(screen.getByText("Loading projects…")).toBeInTheDocument();
    resolveFetch(jsonResponse(200, { projects: [] }));
    await waitFor(() => expect(screen.getByText("No projects yet.")).toBeInTheDocument());
  });

  it("shows a backend error state when the fetch fails, rather than a blank or fabricated page", async () => {
    stubFetch("error");
    renderProjects();
    await waitFor(() => expect(screen.getByText(/Database unavailable/)).toBeInTheDocument());
  });

  it("A: renders the real MasterMind project from GET /api/projects — its real courseCount > 0 is what lets the card say Whop, with type/source/live stats", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
    expect(screen.getByText("Whop")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByText("Lessons")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
  });

  it("B: a project with zero sources (courseCount 0) never displays Whop as its project source — shows a neutral label instead", async () => {
    const emptyProject: ProjectSummary = {
      id: 8,
      name: "SecondProject",
      projectType: "GENERAL_KNOWLEDGE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      courseCount: 0,
      lessonCount: 0,
      analyzedLessonCount: 0,
      latestSynthesisStatus: null,
      latestSynthesisCompletedAt: null,
    };
    stubFetch([emptyProject]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "SecondProject" })).toBeInTheDocument());
    expect(screen.getByText("No sources yet")).toBeInTheDocument();
    expect(screen.queryByText("Whop")).not.toBeInTheDocument();
  });

  it("clicking Open on MasterMind navigates into the project workspace using its real numeric id", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument();
  });

  it("New Project opens a dialog listing both project types, with General Knowledge marked Coming Soon", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Trading Strategies")).toBeInTheDocument();
    const generalKnowledgeOption = within(dialog).getByText("General Knowledge").closest("button")!;
    expect(generalKnowledgeOption).toHaveTextContent("Coming Soon");
  });

  it("never pretends a new project was created — selecting a type shows the honest deferral message (POST /api/projects deferred to Phase 4C)", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("General Knowledge").closest("button")!);
    expect(screen.getByText("Project creation will be enabled in the next platform phase.")).toBeInTheDocument();
  });
});
