import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ProjectsPage } from "../ProjectsPage";

function renderProjects() {
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId/sources" element={<div>SOURCES_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectsPage", () => {
  it("shows the MasterMind project card with its type", () => {
    renderProjects();
    expect(screen.getByRole("heading", { name: "MasterMind" })).toBeInTheDocument();
    expect(screen.getByText("Trading Strategies")).toBeInTheDocument();
  });

  it("clicking Open Project on MasterMind navigates into the project workspace", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "Open Project" }));
    expect(screen.getByText("SOURCES_PAGE_MARKER")).toBeInTheDocument();
  });

  it("+ New Project opens a dialog listing both project types, with General Knowledge marked Coming Soon", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Trading Strategies")).toBeInTheDocument();
    const generalKnowledgeOption = within(dialog).getByText("General Knowledge").closest("button")!;
    expect(generalKnowledgeOption).toHaveTextContent("Coming Soon");
  });

  it("never pretends a new project was created — selecting a type shows the honest deferral message", () => {
    renderProjects();
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText("General Knowledge").closest("button")!);
    expect(screen.getByText("Project creation will be enabled in the next platform phase.")).toBeInTheDocument();
  });
});
