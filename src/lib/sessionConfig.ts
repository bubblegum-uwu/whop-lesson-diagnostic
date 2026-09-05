/**
 * Stores which OAuth flow is in flight (course sign-in, or the legacy
 * single-lesson diagnostic) plus its non-secret inputs in sessionStorage
 * only, so a page reload during the OAuth redirect round-trip doesn't lose
 * them. The Whop OAuth client_id itself is no longer user-supplied (it's a
 * build-time constant — see scarfaceCourseConfig.ts), so it's no longer
 * stored here at all.
 */

const CONFIG_KEY = "whop_diagnostic_config";

export type DiagnosticConfig =
  | { flow: "course" }
  | { flow: "diagnostic"; lessonUrl: string };

export function saveConfig(config: DiagnosticConfig): void {
  sessionStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function loadConfig(): DiagnosticConfig | null {
  const raw = sessionStorage.getItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DiagnosticConfig;
  } catch {
    return null;
  }
}

export function clearConfig(): void {
  sessionStorage.removeItem(CONFIG_KEY);
}
