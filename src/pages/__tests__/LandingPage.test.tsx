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
  it("shows the Knovera wordmark, eyebrow, headline, and supporting copy", () => {
    renderLanding();
    expect(screen.getByText("Knovera")).toBeInTheDocument();
    expect(screen.getByText("The Knowledge Synthesis Platform")).toBeInTheDocument();

    const headline = screen.getByRole("heading", { level: 1 });
    expect(headline.textContent).toContain("Watch less.");
    expect(headline.textContent).toContain("Know more.");

    expect(screen.getByText("~100,000 hours")).toBeInTheDocument();
    expect(screen.getByText(/Knovera turns the information you could never watch/)).toBeInTheDocument();
    expect(screen.getByText("Sources → Analysis → Knowledge → Intelligence")).toBeInTheDocument();
  });

  it("does not show fabricated marketing content (testimonials/feature lists)", () => {
    renderLanding();
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
  });

  it("Enter Knovera navigates to /projects", () => {
    renderLanding();
    fireEvent.click(screen.getByRole("button", { name: /Enter Knovera/ }));
    expect(screen.getByText("PROJECTS_PAGE_MARKER")).toBeInTheDocument();
  });
});
