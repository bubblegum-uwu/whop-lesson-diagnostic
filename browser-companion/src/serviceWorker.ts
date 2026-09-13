/**
 * The extension's background orchestrator. Relays between the Knovera tab
 * (via knoveraContentScript.ts) and the Discord tab it opens/reuses (via
 * discordContentScript.ts) — this is the ONLY module that ever calls
 * `chrome.tabs.create`/`chrome.tabs.update` to navigate to a Discord
 * channel, and it does so only in direct response to an explicit
 * SCAN_START request that originated from the user clicking "Scan
 * Channel" in Knovera. Holds no Knovera credentials (none are ever sent
 * to it — see knoveraContentScript.ts's doc comment) and no Discord
 * credentials (it never reads cookies/tokens; it only opens a tab and
 * exchanges structured messages with the content script running inside
 * it). Requires live-browser validation — chrome.tabs/chrome.runtime
 * don't exist in a unit-test environment.
 */
import { MESSAGE_MARKER, PROTOCOL_VERSION, isToExtensionMessage, isDiscordTabEvent, type ToPageMessage } from "./bridgeProtocol.js";

interface PendingScan {
  knoveraTabId: number;
  discordTabId: number;
}

const pendingScans = new Map<string, PendingScan>();

function sendToKnoveraTab(tabId: number, message: ToPageMessage): void {
  chrome.tabs.sendMessage(tabId, message);
}

function openOrReuseDiscordTab(channelUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: "https://discord.com/*" }, (tabs) => {
      const existing = tabs.find((tab) => tab.url === channelUrl);
      if (existing?.id != null) {
        resolve(existing.id);
        return;
      }
      chrome.tabs.create({ url: channelUrl, active: true }, (tab) => {
        if (tab.id == null) {
          reject(new Error("Could not open a Discord tab."));
          return;
        }
        const tabId = tab.id;
        function onUpdated(updatedTabId: number, changeInfo: { status?: string }) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve(tabId);
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    });
  });
}

async function handleScanStart(knoveraTabId: number, requestId: string, channelUrl: string): Promise<void> {
  try {
    const discordTabId = await openOrReuseDiscordTab(channelUrl);
    pendingScans.set(requestId, { knoveraTabId, discordTabId });
    chrome.tabs.sendMessage(discordTabId, { type: "START_SCAN", requestId });
  } catch (err) {
    sendToKnoveraTab(knoveraTabId, {
      [MESSAGE_MARKER]: true,
      direction: "toPage",
      version: PROTOCOL_VERSION,
      type: "SCAN_ERROR",
      requestId,
      message: err instanceof Error ? err.message : "Could not start the Discord scan.",
    });
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (isToExtensionMessage(message)) {
    const knoveraTabId = sender.tab?.id;
    if (knoveraTabId == null) return;

    if (message.type === "PING") {
      sendToKnoveraTab(knoveraTabId, { [MESSAGE_MARKER]: true, direction: "toPage", version: PROTOCOL_VERSION, type: "PONG" });
      return;
    }
    if (message.type === "SCAN_START") {
      void handleScanStart(knoveraTabId, message.requestId, message.channelUrl);
      return;
    }
    if (message.type === "SCAN_CANCEL") {
      const pending = pendingScans.get(message.requestId);
      if (pending) chrome.tabs.sendMessage(pending.discordTabId, { type: "CANCEL_SCAN", requestId: message.requestId });
      return;
    }
    return;
  }

  if (isDiscordTabEvent(message)) {
    const pending = pendingScans.get(message.requestId);
    if (!pending) return;

    if (message.type === "SCAN_PROGRESS") {
      sendToKnoveraTab(pending.knoveraTabId, {
        [MESSAGE_MARKER]: true,
        direction: "toPage",
        version: PROTOCOL_VERSION,
        type: "SCAN_PROGRESS",
        requestId: message.requestId,
        progress: message.progress,
      });
      return;
    }
    if (message.type === "SCAN_RESULT") {
      sendToKnoveraTab(pending.knoveraTabId, {
        [MESSAGE_MARKER]: true,
        direction: "toPage",
        version: PROTOCOL_VERSION,
        type: "SCAN_RESULT",
        requestId: message.requestId,
        result: message.result,
      });
      pendingScans.delete(message.requestId);
      return;
    }
    if (message.type === "SCAN_ERROR") {
      sendToKnoveraTab(pending.knoveraTabId, {
        [MESSAGE_MARKER]: true,
        direction: "toPage",
        version: PROTOCOL_VERSION,
        type: "SCAN_ERROR",
        requestId: message.requestId,
        message: message.message,
      });
      pendingScans.delete(message.requestId);
    }
  }
});
