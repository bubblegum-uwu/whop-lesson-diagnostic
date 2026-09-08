import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { KnoveraMark } from "./KnoveraMark";

export interface AppShellProps {
  children: ReactNode;
  /** Phase 4D — ends the Knovera session (see App.tsx's handleKnoveraLogout). Optional only so AppShell itself stays usable without wiring this up in a test; every real route passes it via AppShellLayout below. */
  onLogout?: () => void;
  /** Phase 4D.1 — the authenticated operator's email (from /api/knovera-auth/me), shown in the account menu and used to derive the avatar initial. Null while not yet loaded. */
  email?: string | null;
}

/** Derives a single display initial from an email address, e.g. "andy.dey@gmail.com" -> "A". Falls back to "K" (Knovera) when no email is known yet. */
function initialFromEmail(email: string | null | undefined): string {
  const trimmed = email?.trim();
  if (!trimmed) return "K";
  return trimmed[0].toUpperCase();
}

/** The small account menu behind the top-nav avatar: shows the authenticated email and a Sign out action. Opens on click, closes on outside click, Escape, or after sign-out — the avatar click itself never logs out directly. */
function AccountMenu({ email, onLogout }: { email?: string | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function handleSignOut() {
    setOpen(false);
    onLogout();
  }

  return (
    <div className="kv-account-menu" ref={ref}>
      <button
        type="button"
        className="kv-topnav-avatar"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        {initialFromEmail(email)}
      </button>
      {open && (
        <div className="kv-account-menu-list" role="menu">
          {email && (
            <>
              <div className="kv-account-menu-email" role="none">
                {email}
              </div>
              <div className="kv-account-menu-divider" role="none" />
            </>
          )}
          <button type="button" role="menuitem" className="kv-account-menu-item" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The lightweight top-level Knovera navigation ("Knovera / Projects /
 * Usage"), present on every in-app route except the landing/login pages
 * (standalone entry screens, not part of the app shell). No sidebar — per
 * the Phase 4 spec, this is intentionally minimal. Visual-polish pass:
 * active nav state reads as a soft filled pill (via
 * .knovera-topnav-link.active in index.css), never a bright solid button.
 */
export function AppShell({ children, onLogout, email }: AppShellProps) {
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
        {onLogout ? (
          <AccountMenu email={email} onLogout={onLogout} />
        ) : (
          <div className="kv-topnav-avatar" aria-hidden="true">
            {initialFromEmail(email)}
          </div>
        )}
      </header>
      <main className="knovera-main">{children}</main>
    </div>
  );
}

/** A route-tree layout variant of AppShell — wraps whatever the active nested route renders via <Outlet/>. Used as the parent element for every in-app route (see App.tsx's <Routes>). */
export function AppShellLayout({ onLogout, email }: { onLogout?: () => void; email?: string | null }) {
  return (
    <AppShell onLogout={onLogout} email={email}>
      <Outlet />
    </AppShell>
  );
}
