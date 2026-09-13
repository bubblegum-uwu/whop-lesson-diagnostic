/**
 * Pure manifest-generation logic (no filesystem/process access) — kept
 * separate from generateManifest.mjs so it's directly unit-testable from
 * browser-companion/tests/ without shelling out or touching disk.
 *
 * The Discord content script's `matches` is fixed and NOT configurable
 * here (see manifest.template.json) — only the Knovera-bridge content
 * script's origins are build-time configurable, since that's the one
 * thing that legitimately differs between local dev, a Cloud Shell
 * preview, and production.
 */

export const DEFAULT_KNOVERA_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];

export class InvalidMatchPatternError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidMatchPatternError";
  }
}

/**
 * Rejects the overly-broad patterns this project must never request
 * (`<all_urls>`, a wildcard scheme, or a wildcard host that matches every
 * website) while still allowing a normal explicit origin, with or without
 * a wildcard subdomain (e.g. `https://*.knovera.example.com/*`) or port.
 */
export function assertNarrowMatchPattern(pattern) {
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    throw new InvalidMatchPatternError("A Knovera match pattern cannot be empty.");
  }
  const trimmed = pattern.trim();
  if (trimmed === "<all_urls>") {
    throw new InvalidMatchPatternError(`Refusing overly broad match pattern: "${trimmed}" (matches every URL on every scheme).`);
  }
  const parsed = /^(https?|\*):\/\/([^/]+)\/.*$/.exec(trimmed);
  if (!parsed) {
    throw new InvalidMatchPatternError(`"${trimmed}" is not a recognized <scheme>://<host>/<path> match pattern.`);
  }
  const [, scheme, host] = parsed;
  if (scheme === "*") {
    throw new InvalidMatchPatternError(`Refusing a wildcard scheme in "${trimmed}" — an explicit http/https scheme is required.`);
  }
  if (host === "*") {
    throw new InvalidMatchPatternError(`Refusing "${trimmed}" — a bare "*" host matches every website, not just Knovera's.`);
  }
  return trimmed;
}

/** Parses a comma-separated KNOVERA_COMPANION_MATCHES value into a trimmed, de-duplicated, validated list — empty/whitespace-only input falls back to the localhost/127.0.0.1 dev defaults. */
export function parseKnoveraMatches(rawValue) {
  const trimmedInput = typeof rawValue === "string" ? rawValue.trim() : "";
  if (trimmedInput.length === 0) {
    return [...DEFAULT_KNOVERA_MATCHES];
  }
  const patterns = trimmedInput
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const validated = patterns.map(assertNarrowMatchPattern);
  return [...new Set(validated)];
}

/**
 * Builds the final, generated manifest object from the template plus the
 * resolved Knovera match list — the ONLY thing this function changes is
 * appending one additional `content_scripts` entry; every other template
 * field (permissions, host_permissions, the Discord content script,
 * background) passes through untouched, so a change here can never
 * silently widen anything else.
 */
export function buildManifest(template, knoveraMatches) {
  if (!Array.isArray(knoveraMatches) || knoveraMatches.length === 0) {
    throw new InvalidMatchPatternError("At least one Knovera match pattern is required.");
  }
  return {
    ...template,
    content_scripts: [
      ...template.content_scripts,
      {
        matches: knoveraMatches,
        js: ["knoveraContentScript.js"],
        run_at: "document_start",
      },
    ],
  };
}
