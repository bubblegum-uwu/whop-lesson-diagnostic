/**
 * Runs on discord.com/channels/* (see manifest.json). Idle until it
 * receives a START_SCAN command from the service worker — there is no
 * `matches` entry that fires this on discord.com generally, no scan logic
 * runs on page load, and nothing here executes without an explicit
 * incoming message that ultimately traces back to the user clicking "Scan
 * Channel" in Knovera. Only ever reads message ids, timestamps, and
 * anchor hrefs from the rendered page via discordAdapter.ts/
 * discordScanner.ts — never `document.cookie`, never `localStorage`,
 * never an Authorization header, never Discord's private API. Requires
 * live-browser validation against real Discord markup (the DOM-adapter
 * selectors themselves are covered by this package's fixture-based tests,
 * but the actual chrome.* wiring below is not something a unit test
 * environment can exercise).
 */
import { scanChannelMessages, type ScannerEnvironment } from "./discordScanner.js";
import { parseDiscordChannelUrl, DiscordChannelUrlParseError } from "./discordChannelUrl.js";
import { findScroller, findChannelName } from "./discordAdapter.js";
import { isDiscordTabCommand } from "./bridgeProtocol.js";
import type { DiscordScanResult } from "./types.js";

const SCROLL_SETTLE_DELAY_MS = 700;

const activeCancelFlags = new Map<string, { cancelled: boolean }>();

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isDiscordTabCommand(message)) return;
  if (message.type === "START_SCAN") {
    void runScan(message.requestId);
  } else if (message.type === "CANCEL_SCAN") {
    const flag = activeCancelFlags.get(message.requestId);
    if (flag) flag.cancelled = true;
  }
});

async function runScan(requestId: string): Promise<void> {
  const cancelFlag = { cancelled: false };
  activeCancelFlags.set(requestId, cancelFlag);
  try {
    let channel;
    try {
      channel = parseDiscordChannelUrl(window.location.href);
    } catch (err) {
      chrome.runtime.sendMessage({
        type: "SCAN_ERROR",
        requestId,
        message: err instanceof DiscordChannelUrlParseError ? err.message : "Could not read this channel's identity from the current page.",
      });
      return;
    }

    const env: ScannerEnvironment = {
      getRoot: () => document,
      scrollOlder: () => {
        const scroller = findScroller(document);
        if (scroller) scroller.scrollTop = 0;
      },
      wait: () => new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_DELAY_MS)),
      isCancelled: () => cancelFlag.cancelled,
      onProgress: (progress) => chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", requestId, progress }),
    };

    const scanResult = await scanChannelMessages(env, channel);
    const result: DiscordScanResult = {
      channel: { guildId: channel.guildId, channelId: channel.channelId, channelName: findChannelName(document) },
      occurrences: scanResult.occurrences,
      messagesScanned: scanResult.messagesScanned,
      cancelled: scanResult.cancelled,
    };
    chrome.runtime.sendMessage({ type: "SCAN_RESULT", requestId, result });
  } finally {
    activeCancelFlags.delete(requestId);
  }
}
