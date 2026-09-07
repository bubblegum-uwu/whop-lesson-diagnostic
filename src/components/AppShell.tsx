import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";

/**
 * Phase 4A — the lightweight top-level Knovera navigation ("Knovera /
 * Projects / Usage"), present on every in-app route except the landing page
 * (which is a standalone entry screen, not part of the app shell). No
 * sidebar — per the Phase 4 spec, this is intentionally minimal.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="knovera-shell">
      <header className="knovera-topnav">
        <NavLink to="/projects" className="knovera-topnav-brand">
          Knovera
        </NavLink>
        <nav className="knovera-topnav-links">
          <NavLink to="/projects" className={({ isActive }) => (isActive ? "knovera-topnav-link active" : "knovera-topnav-link")}>
            Projects
          </NavLink>
          <NavLink to="/usage" className={({ isActive }) => (isActive ? "knovera-topnav-link active" : "knovera-topnav-link")}>
            Usage
          </NavLink>
        </nav>
      </header>
      <main className="knovera-main">{children}</main>
    </div>
  );
}

/** A route-tree layout variant of AppShell — wraps whatever the active nested route renders via <Outlet/>. Used as the parent element for every in-app route (see App.tsx's <Routes>). */
export function AppShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
