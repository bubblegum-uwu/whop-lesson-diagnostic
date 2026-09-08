import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AppShellLayout } from "../AppShell";

function renderShell(props: { onLogout?: () => void; email?: string | null } = {}) {
  render(
    <MemoryRouter initialEntries={["/projects"]}>
      <Routes>
        <Route element={<AppShellLayout {...props} />}>
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

describe("AppShell account menu (Phase 4D.1)", () => {
  it("A: renders an account trigger for an authenticated user (onLogout supplied)", () => {
    renderShell({ onLogout: vi.fn(), email: "andy.dey@example.com" });
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });

  it("B: uses a sensible user initial derived from the email, not an unexplained 'K'", () => {
    renderShell({ onLogout: vi.fn(), email: "andy.dey@example.com" });
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveTextContent("A");
  });

  it("falls back to 'K' when no email is known yet", () => {
    renderShell({ onLogout: vi.fn(), email: null });
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveTextContent("K");
  });

  it("C/D: clicking the trigger opens the account menu and shows the authenticated email", () => {
    renderShell({ onLogout: vi.fn(), email: "andy.dey@example.com" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("andy.dey@example.com")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });

  it("the avatar click itself never logs out directly", () => {
    const onLogout = vi.fn();
    renderShell({ onLogout, email: "andy.dey@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("E/F: clicking Sign out invokes the existing logout flow and closes the menu", () => {
    const onLogout = vi.fn();
    renderShell({ onLogout, email: "andy.dey@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("G: pressing Escape closes the open menu", () => {
    renderShell({ onLogout: vi.fn(), email: "andy.dey@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("H: clicking outside the menu closes it", () => {
    renderShell({ onLogout: vi.fn(), email: "andy.dey@example.com" });
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
