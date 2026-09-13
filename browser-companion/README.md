# Knovera Browser Companion

A Manifest V3 Chrome extension (Phase 4K-C) that scans a Discord channel
you're already logged into, in your own browser, and hands discovered
YouTube links back to the Knovera web app. It is **not a bot** — no
server-side automation, no Discord app installation, no admin permission,
no access to your Discord login.

## What it does and does not do

- Scans ONLY after you click "Scan Channel" in Knovera. No background
  scanning, no scanning on page load.
- Reads only what's already rendered on the Discord page you can see:
  message ids, message timestamps, and anchor links. Never reads message
  text/bodies, usernames, cookies, or `localStorage`.
- Never reads or transmits your Discord auth token.
- Never receives or stores your Knovera login token — see
  `src/knoveraContentScript.ts`'s doc comment for the trust boundary.
- `host_permissions` is `https://discord.com/*` only (see `manifest.json`).

## Building

`npm run build` produces ONE self-contained, loadable directory at
`browser-companion/dist/` — `manifest.json` plus three bundled JS files
(`serviceWorker.js`, `discordContentScript.js`, `knoveraContentScript.js`),
each a standalone esbuild IIFE bundle with no unresolved `import`
statements (every module it depends on is inlined). Nothing else needs to
be copied by hand, and nothing from `src/`, `tests/`, or `node_modules/`
needs to be (or should be) loaded into Chrome. The build ends with an
automatic verification pass (`scripts/verifyBuild.mjs`) that fails loudly
if `manifest.json` is missing, a file it references doesn't exist, or a
bundle still contains a top-level import/export.

The ONE thing that varies by environment is which origin(s) the Knovera
bridge content script (`knoveraContentScript.ts`) is allowed to run on —
set via the `KNOVERA_COMPANION_MATCHES` env var, a comma-separated list of
explicit match patterns. This is intentionally its own narrow knob,
separate from `host_permissions` (which stays `https://discord.com/*`
always, unaffected by this setting) — see `scripts/manifestConfig.mjs`'s
`assertNarrowMatchPattern`, which refuses `<all_urls>` and any bare
wildcard scheme/host outright (an invalid/overly-broad value fails the
build rather than silently widening what the extension can run on).

**1. Local dev (default — no env var needed):**
```sh
cd browser-companion && npm install
npm run build
```
Matches `http://localhost/*` and `http://127.0.0.1/*` by default.

**2. An explicit Cloud Shell (or any other) preview origin:**
```sh
KNOVERA_COMPANION_MATCHES="http://localhost/*,https://5175-YOUR-PREVIEW-ID.cloudshell.dev/*" \
  npm run build
```
Replace the Cloud Shell URL with the exact current preview origin — it
changes per Cloud Shell session, so this is never hard-coded into
committed source (see `manifest.template.json`, which ships with NO
Knovera-origin entry at all until generated).

**3. Production:**
```sh
KNOVERA_COMPANION_MATCHES="https://your-deployed-knovera-domain.example.com/*" \
  npm run build
```

Then, for any of the above:

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select `browser-companion/dist/` (the
   directory the build just produced — not `browser-companion/` itself).
3. Reload the Knovera web app at the origin you configured. The "Import
   YouTube from a Channel" dialog under the Discord provider card should
   now detect the companion instead of showing "Knovera Browser Companion
   is required."

Re-run the build (with the right `KNOVERA_COMPANION_MATCHES`) and click the
reload icon on the extension's card in `chrome://extensions` whenever you
switch environments or change the sources.

## Architecture

- `src/types.ts` — shared scan/occurrence/progress types.
- `src/youtubeLinkExtractor.ts` — recognizes supported YouTube URL forms
  among a message's anchor hrefs (pre-filter only; the Knovera backend is
  the authoritative validator/canonicalizer).
- `src/discordAdapter.ts` — the ONLY module with Discord-specific CSS
  selectors, isolated so a future Discord markup change means editing this
  one file, never `discordScanner.ts`'s traversal/dedup logic.
- `src/discordScanner.ts` — the scan loop: inspect rendered messages,
  dedup by message id across virtualized re-renders, scroll toward older
  history, repeat until cancelled or a deterministic no-progress condition
  is met. Fully unit-testable (`tests/discordScanner.test.ts`) via an
  injected `ScannerEnvironment` — no live Discord or chrome.* APIs needed.
- `src/discordChannelUrl.ts` — channel URL parsing + safe permalink
  derivation (`https://discord.com/channels/<guild>/<channel>[/<message>]`).
- `src/bridgeProtocol.ts` — the typed message protocol between the Knovera
  page, the extension, and the Discord tab.
- `src/knoveraContentScript.ts` — runs on the Knovera origin; relays
  `window.postMessage` <-> `chrome.runtime`. Never reads the page, never
  calls `fetch`, never touches the Knovera token.
- `src/discordContentScript.ts` — runs on `discord.com/channels/*`; idle
  until it receives a scan command, then drives `discordScanner.ts`
  against the live page. Also answers a lightweight `READY_CHECK` probe
  (see below) so the service worker can tell whether it's actually loaded.
- `src/discordTabReadiness.ts` — pure, dependency-injected retry/recovery
  logic: probes a Discord tab's content script with a bounded timeout,
  retries a bounded number of times, and (for a tab that predates the
  extension being installed/reloaded) reloads it once before retrying —
  never waits forever, never assumes an already-open tab has a live
  content script.
- `src/serviceWorker.ts` — background orchestrator: opens/reuses the
  Discord tab (using `discordTabReadiness.ts` before ever sending
  `START_SCAN`), relays commands/events between the two content scripts,
  and reports a clear `SCAN_ERROR` if a tab never becomes ready.
- `manifest.template.json` + `scripts/generateManifest.mjs` +
  `scripts/manifestConfig.mjs` — build-time manifest generation (see
  "Building" above): the template ships with no Knovera-origin content
  script at all; the generator appends one, built from
  `KNOVERA_COMPANION_MATCHES`, after validating it's never `<all_urls>` or
  a bare wildcard.
- `scripts/build.mjs` + `scripts/verifyBuild.mjs` /
  `scripts/verifyBuildLogic.mjs` — the esbuild bundling step and its
  automatic post-build sanity check.

## Testing

`npm test` runs the full suite (`tests/`), covering:

- Channel URL parsing, YouTube link recognition, DOM adapter extraction,
  and the scan loop's dedup/multi-link/multi-occurrence/termination/
  cancellation behavior — against static DOM fixtures
  (`tests/fixtures/discordDom.ts`), since this environment has no live
  Discord access.
- Manifest generation (`tests/manifestConfig.test.ts`): explicit Knovera
  origins are accepted, `<all_urls>`/wildcard patterns are rejected, and
  the generated manifest contains exactly the Discord match plus the
  configured Knovera match(es) — never anything broader.
- Build-artifact verification (`tests/verifyBuildLogic.test.ts`): every
  file the manifest references must exist, and none may contain a
  top-level import/export.
- Discord-tab readiness (`tests/discordTabReadiness.test.ts`,
  `tests/serviceWorkerIntegration.test.ts`): an already-open, ready tab is
  reused without reloading; an already-open, unresponsive tab is
  recovered via reload then scanned; a freshly-opened tab waits for
  readiness without ever reloading; a tab that never becomes ready
  reports `SCAN_ERROR` (bounded retries — never hangs forever); explicit
  cancellation is honored both mid-scan and while still waiting on
  readiness. The `serviceWorkerIntegration` suite drives the actual
  `serviceWorker.ts` module against an in-memory fake `chrome.*`
  (`tests/fixtures/fakeChrome.ts`), not just the extracted readiness
  logic in isolation.
- `knoveraContentScript.ts`'s trust boundary
  (`tests/knoveraContentScriptTrustBoundary.test.ts`): a static-source
  regression guard failing loudly if the file ever gains a
  cookie/localStorage/fetch/DOM-read/Authorization-header reference.

`discordContentScript.ts` and `knoveraContentScript.ts`'s actual chrome.*
wiring (as opposed to the pure logic they call into, which IS tested) and
`discordAdapter.ts`'s selectors against Discord's REAL current markup
still require manual, live-browser validation — see the repository's PR
description for the manual test plan.
