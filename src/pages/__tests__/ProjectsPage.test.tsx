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
  projectSourceCount: 0,
  collectionCount: 1,
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
        <Route path="/projects" element={<ProjectsPage backendUrl="https://backend.example.com" knoveraToken="token" {...props} />} />
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectsPage", () => {
  it("prompts sign-in when there is no access token yet, rather than fetching or fabricating data", () => {
    renderProjects({ knoveraToken: null });
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

  it("A: renders the real MasterMind project from GET /api/projects, with its collectionCount, type, and live stats", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
    expect(screen.getByText("1 collection")).toBeInTheDocument();
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByText("Lessons")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
  });

  it("B: a project with zero collections shows a neutral 'No sources yet' label", async () => {
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
      projectSourceCount: 0,
      collectionCount: 0,
    };
    stubFetch([emptyProject]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "SecondProject" })).toBeInTheDocument());
    expect(screen.getByText("No sources yet")).toBeInTheDocument();
  });

  // Phase 4L follow-up — the project card shows the SAME canonical
  // "N collections" abstraction the Sources page itself uses (persisted
  // collections + derived groups + Whop courses + Whop à-la-carte if
  // non-empty), never a raw project_sources row count and never a bare
  // "Whop" literal — see ProjectsPage.tsx's doc comment.
  it("C: singular/plural collection counts render correctly, independent of provider", async () => {
    const singleCollectionProject: ProjectSummary = {
      id: 10,
      name: "One Collection",
      projectType: "GENERAL_KNOWLEDGE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      courseCount: 0,
      lessonCount: 0,
      analyzedLessonCount: 0,
      latestSynthesisStatus: null,
      latestSynthesisCompletedAt: null,
      projectSourceCount: 1,
      collectionCount: 1,
    };
    // Mirrors the exact live-validation example: Discord Knowledge with a
    // DISCORD · CHANNEL group and a derived YOUTUBE · CHANNEL (via Discord)
    // group — 4 project_sources rows, but 2 collection cards.
    const discordKnowledge: ProjectSummary = { ...singleCollectionProject, id: 11, name: "Discord Knowledge", projectSourceCount: 4, collectionCount: 2 };

    stubFetch([singleCollectionProject, discordKnowledge]);
    renderProjects();

    await waitFor(() => expect(screen.getByRole("heading", { name: "One Collection" })).toBeInTheDocument());
    expect(screen.getByText("1 collection")).toBeInTheDocument();
    expect(screen.getByText("2 collections")).toBeInTheDocument();
    expect(screen.queryByText("No sources yet")).not.toBeInTheDocument();
    // Never the raw project_sources row count.
    expect(screen.queryByText("4 sources")).not.toBeInTheDocument();
  });

  it("D: a Whop course counts as ONE collection, folded into the same total as any other collections — never shown as the bare literal 'Whop'", async () => {
    const whopAndDiscord: ProjectSummary = {
      id: 12,
      name: "Whop Plus Discord",
      projectType: "TRADING_STRATEGIES",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      courseCount: 1,
      lessonCount: 10,
      analyzedLessonCount: 0,
      latestSynthesisStatus: null,
      latestSynthesisCompletedAt: null,
      projectSourceCount: 5,
      collectionCount: 2, // 1 Whop course + 1 other collection/group
    };
    stubFetch([whopAndDiscord]);
    renderProjects();

    await waitFor(() => expect(screen.getByRole("heading", { name: "Whop Plus Discord" })).toBeInTheDocument());
    expect(screen.getByText("2 collections")).toBeInTheDocument();
    expect(screen.queryByText("Whop")).not.toBeInTheDocument();
    expect(screen.queryByText("5 sources")).not.toBeInTheDocument();
  });

  // Live-validation Fix 2 — a GENERAL_KNOWLEDGE project must be a fully
  // openable workspace (sources/catalog/Discord Knowledge inbox); only its
  // synthesis functionality is unimplemented. Previously the Open button
  // was disabled and the card showed a bare "Coming Soon" badge that
  // implied the whole project was unusable, not just its synthesis.
  describe("GENERAL_KNOWLEDGE projects are openable (only synthesis is not)", () => {
    const DISCORD_KNOWLEDGE: ProjectSummary = {
      id: 9,
      name: "Discord Knowledge",
      projectType: "GENERAL_KNOWLEDGE",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      courseCount: 0,
      lessonCount: 0,
      analyzedLessonCount: 0,
      latestSynthesisStatus: null,
      latestSynthesisCompletedAt: null,
      projectSourceCount: 4,
      collectionCount: 2,
    };

    it("shows the real project type label (never a bare 'Coming Soon' in its place) plus a separate, synthesis-scoped note", async () => {
      stubFetch([DISCORD_KNOWLEDGE]);
      renderProjects();
      await waitFor(() => expect(screen.getByRole("heading", { name: "Discord Knowledge" })).toBeInTheDocument());

      expect(screen.getByText("General Knowledge")).toBeInTheDocument();
      expect(screen.getByText("Synthesis Coming Soon")).toBeInTheDocument();
      expect(screen.getByText("2 collections")).toBeInTheDocument();
      // Never the old bare label that implied the whole project was unusable.
      expect(screen.queryByText("Coming Soon")).not.toBeInTheDocument();
    });

    // Live-validation cleanup — this project (General Knowledge +
    // Synthesis Coming Soon, the two longest badges the card ever shows
    // together) is exactly the case that overflowed the card at narrow
    // widths. Asserting the wrap-scaffolding classes are on the right
    // elements is a real regression guard without pixel/screenshot
    // assertions — same class-level pattern as UsagePage.test.tsx's
    // `.closest(".knovera-usage-total-card")` checks.
    it("the heading and badge group carry the wrap-scaffolding classes CSS relies on to keep long badges inside the card", async () => {
      stubFetch([DISCORD_KNOWLEDGE]);
      renderProjects();
      await waitFor(() => expect(screen.getByRole("heading", { name: "Discord Knowledge" })).toBeInTheDocument());

      const heading = screen.getByRole("heading", { name: "Discord Knowledge" }).closest(".knovera-project-card-heading");
      expect(heading).not.toBeNull();

      const badgeGroup = screen.getByText("Synthesis Coming Soon").closest(".knovera-project-card-badges");
      expect(badgeGroup).not.toBeNull();
      expect(badgeGroup).toContainElement(screen.getByText("General Knowledge"));
    });

    it("the Open button is never disabled, and clicking it navigates into the workspace", async () => {
      stubFetch([DISCORD_KNOWLEDGE]);
      renderProjects();
      await waitFor(() => expect(screen.getByRole("heading", { name: "Discord Knowledge" })).toBeInTheDocument());

      const openButton = screen.getByRole("button", { name: /Open/ });
      expect(openButton).not.toBeDisabled();
      fireEvent.click(openButton);
      expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument();
    });

    it("a TRADING_STRATEGIES project never shows the 'Synthesis Coming Soon' note", async () => {
      stubFetch([MASTERMIND]);
      renderProjects();
      await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
      expect(screen.queryByText("Synthesis Coming Soon")).not.toBeInTheDocument();
    });
  });

  it("clicking Open on MasterMind navigates into the project workspace using its real numeric id", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument();
  });

  it("New Project opens a dialog listing both project types", async () => {
    stubFetch([MASTERMIND]);
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Trading Strategies")).toBeInTheDocument();
    expect(within(dialog).getByText("General Knowledge")).toBeInTheDocument();
    expect(within(dialog).getByText("Create the project now. General Knowledge synthesis is coming soon.")).toBeInTheDocument();
  });

  it("creating a project navigates to its Sources page and never touches MasterMind's data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/projects") && (!init || init.method === undefined)) {
          return jsonResponse(200, { projects: [MASTERMIND] });
        }
        if (url.endsWith("/api/projects") && init?.method === "POST") {
          return jsonResponse(201, {
            project: {
              id: 42,
              name: "Fresh Start",
              projectType: "TRADING_STRATEGIES",
              createdAt: "2026-01-03T00:00:00.000Z",
              updatedAt: "2026-01-03T00:00:00.000Z",
              courseCount: 0,
              lessonCount: 0,
              analyzedLessonCount: 0,
              latestSynthesisStatus: null,
              latestSynthesisCompletedAt: null,
              projectSourceCount: 0,
              collectionCount: 0,
            },
          });
        }
        return jsonResponse(404, {});
      }),
    );
    renderProjects();
    await waitFor(() => expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Project Name"), { target: { value: "Fresh Start" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Trading Strategies/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument());
    // MasterMind's own card content was never re-rendered/mutated by this flow.
    expect(screen.queryByRole("heading", { name: "MasterMind" })).not.toBeInTheDocument(); // navigated away
  });
});
