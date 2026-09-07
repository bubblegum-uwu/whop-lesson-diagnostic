import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectsPage, type ProjectsPageProps } from "../ProjectsPage";

function renderProjects(props: ProjectsPageProps = {}) {
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage {...props} />} />
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectsPage", () => {
  it("shows the MasterMind project card with its type and Whop source", () => {
    renderProjects();
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
    expect(screen.getByText("Whop")).toBeInTheDocument();
  });

  it("clicking Open on MasterMind navigates into the project workspace", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: /Open/ }));
    expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument();
  });

  it("shows the live lesson count once connected — real frontend state, never fabricated", () => {
    renderProjects({ connected: true, lessonCount: 28 });
    expect(screen.getByText("28")).toBeInTheDocument();
    expect(screen.getByText("Lessons")).toBeInTheDocument();
  });

  it("shows no stats row at all when not connected, rather than a fake number", () => {
    renderProjects({ connected: false });
    expect(screen.queryByText("Lessons")).not.toBeInTheDocument();
  });

  it("New Project opens a dialog listing both project types, with General Knowledge marked Coming Soon", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Trading Strategies")).toBeInTheDocument();
    const generalKnowledgeOption = within(dialog).getByText("General Knowledge").closest("button")!;
    expect(generalKnowledgeOption).toHaveTextContent("Coming Soon");
  });

  it("never pretends a new project was created — selecting a type shows the honest deferral message", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("General Knowledge").closest("button")!);
    expect(screen.getByText("Project creation will be enabled in the next platform phase.")).toBeInTheDocument();
  });
});
