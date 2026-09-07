import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UsagePage } from "../UsagePage";

describe("UsagePage", () => {
  it("shows the Usage & Spend shell with MasterMind and the Phase 4E deferral note", () => {
    render(<UsagePage />);
    expect(screen.getByText("Usage & Spend")).toBeInTheDocument();
    expect(screen.getByText("MasterMind")).toBeInTheDocument();
    expect(screen.getByText("Current-month spend calculation coming in Phase 4E")).toBeInTheDocument();
  });

  it("never shows a fabricated dollar figure", () => {
    render(<UsagePage />);
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });
});
