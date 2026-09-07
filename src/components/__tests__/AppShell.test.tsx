import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShellLayout } from "../AppShell";

function renderShell() {
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route element={<AppShellLayout />}>
          <Route path="/projects" element={<div>PROJECTS_MARKER</div>} />
          <Route path="/usage" element={<div>USAGE_MARKER</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell top navigation", () => {
  it("shows the Knovera brand and Projects/Usage links", () => {
    renderShell();
    expect(screen.getByText("Knovera")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Usage" })).toBeInTheDocument();
  });

  it("clicking Usage in the top nav navigates to the Usage page", () => {
    renderShell();
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    expect(screen.getByText("USAGE_MARKER")).toBeInTheDocument();
  });

  it("clicking the Knovera brand navigates to Projects", () => {
    renderShell();
    fireEvent.click(screen.getByRole("link", { name: "Usage" }));
    fireEvent.click(screen.getByRole("link", { name: "Knovera" }));
    expect(screen.getByText("PROJECTS_MARKER")).toBeInTheDocument();
  });
});
