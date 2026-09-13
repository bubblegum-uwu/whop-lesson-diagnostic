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

## Development install (unpacked)

1. `cd browser-companion && npm install`
2. Build (`npm run build`) or use the TypeScript sources directly with your
   own bundler step — this repo ships the `.ts` sources; Chrome needs
   plain `.js`, so compile first (`npm run build` emits to `dist/`, but you
   must also copy/reference `manifest.json` alongside the compiled output —
   see `npm run build`'s output directory).
3. Open `chrome://extensions`, enable **Developer mode**, click **Load
   unpacked**, and select the built extension directory (containing
   `manifest.json`, `serviceWorker.js`, `discordContentScript.js`,
   `knoveraContentScript.js`).
4. Edit `manifest.json`'s second `content_scripts` entry (`matches`) if
   your local Knovera dev server isn't on `http://localhost` or
   `http://127.0.0.1` — this is the one grant that lets the bridge relay
   script run on the Knovera page itself; update it to your actual
   deployed Knovera origin for anything beyond local dev.
5. Reload the Knovera web app. The "Import YouTube from a Channel" dialog
   under the Discord provider card should now detect the companion instead
   of showing "Knovera Browser Companion is required."

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
  against the live page.
- `src/serviceWorker.ts` — background orchestrator: opens/reuses the
  Discord tab, relays commands/events between the two content scripts.

## Testing

`npm test` runs the fixture-based suite (`tests/`) covering channel URL
parsing, YouTube link recognition, DOM adapter extraction, and the scan
loop's dedup/multi-link/multi-occurrence/termination/cancellation behavior
— all against static DOM fixtures (`tests/fixtures/discordDom.ts`), since
this environment has no live Discord access. `serviceWorker.ts`,
`discordContentScript.ts`, and `knoveraContentScript.ts` are thin chrome.*
wiring over the tested pure modules and require manual, live-browser
validation (see the repository's PR description for the manual test plan).
