import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { LandingPage } from "../LandingPage";

function renderLanding() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/projects" element={<div>PROJECTS_PAGE_MARKER</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LandingPage", () => {
  it("shows Knovera branding, tagline, and hero copy", () => {
    renderLanding();
    expect(screen.getByText("Knovera")).toBeInTheDocument();
    expect(screen.getByText("Watch less. Know more.")).toBeInTheDocument();
    expect(screen.getByText(/100,000 hours of new video/)).toBeInTheDocument();
    expect(screen.getByText(/No one can watch it all/)).toBeInTheDocument();
    expect(screen.getByText(/Knovera turns the universe of video into structured, connected knowledge/)).toBeInTheDocument();
    expect(screen.getByText("Turn endless video into knowledge you can actually use.")).toBeInTheDocument();
  });

  it("does not show fabricated marketing content (testimonials/feature lists)", () => {
    renderLanding();
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
  });

  it("Enter Knovera navigates to /projects", () => {
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: "Enter Knovera" }));
    expect(screen.getByText("PROJECTS_PAGE_MARKER")).toBeInTheDocument();
  });
});
