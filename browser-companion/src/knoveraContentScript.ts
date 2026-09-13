/**
 * Runs ONLY on the Knovera web app's own origin (see manifest.json's
 * second `content_scripts` entry) — this is the entire trust boundary
 * between the Knovera page and the extension. It does exactly one thing:
 * relay `window.postMessage` traffic on this page to/from the extension's
 * service worker over `chrome.runtime`. It never reads this page's DOM,
 * never calls `fetch`, never touches `document.cookie` or
 * `localStorage` — so it never sees, and cannot leak, the Knovera bearer
 * token this page holds. Requires live-browser validation (chrome.* APIs
 * don't exist in a unit-test environment) — the message-shape guards below
 * (`isToExtensionMessage`/`isToPageMessage`) are what's covered by this
 * package's automated tests.
 */
import { isToExtensionMessage, isToPageMessage, type ToPageMessage } from "./bridgeProtocol.js";

function postToPage(message: ToPageMessage): void {
  window.postMessage(message, window.location.origin);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isToExtensionMessage(event.data)) return;
  chrome.runtime.sendMessage(event.data);
});

// The service worker pushes PONG/SCAN_PROGRESS/SCAN_RESULT/SCAN_ERROR
// events to this specific tab (via chrome.tabs.sendMessage) as they
// happen — forwarded straight through to the page, unmodified.
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isToPageMessage(message)) return;
  postToPage(message);
});
