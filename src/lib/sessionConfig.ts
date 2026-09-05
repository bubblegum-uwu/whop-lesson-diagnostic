/**
 * Stores the user-supplied, non-secret diagnostic inputs (client_id and
 * lesson URL) in sessionStorage only, so a page reload during the OAuth
 * redirect round-trip doesn't lose them. Nothing here is a secret:
 * a Whop OAuth client_id is public by design.
 */

const CONFIG_KEY = "whop_diagnostic_config";

export interface DiagnosticConfig {
  clientId: string;
  lessonUrl: string;
}

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
