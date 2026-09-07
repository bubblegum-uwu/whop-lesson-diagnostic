import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { KnoveraMark } from "./KnoveraMark";

/**
 * Phase 4A — the lightweight top-level Knovera navigation ("Knovera /
 * Projects / Usage"), present on every in-app route except the landing page
 * (which is a standalone entry screen, not part of the app shell). No
 * sidebar — per the Phase 4 spec, this is intentionally minimal. Visual-
 * polish pass: active nav state reads as a soft filled pill (via
 * .knovera-topnav-link.active in index.css), never a bright solid button.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="knovera-shell">
      <header className="knovera-topnav">
        <NavLink to="/projects" className="kv-wordmark knovera-topnav-brand">
          <KnoveraMark size={18} />
          <span className="kv-wordmark-text">Knovera</span>
        </NavLink>
        <nav className="knovera-topnav-links">
          <NavLink to="/projects" className={({ isActive }) => (isActive ? "knovera-topnav-link active" : "knovera-topnav-link")}>
            Projects
          </NavLink>
          <NavLink to="/usage" className={({ isActive }) => (isActive ? "knovera-topnav-link active" : "knovera-topnav-link")}>
            Usage
          </NavLink>
        </nav>
        <div className="kv-topnav-avatar" aria-hidden="true">
          K
        </div>
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
