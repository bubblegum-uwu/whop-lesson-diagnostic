/**
 * The extension's background orchestrator. Relays between the Knovera tab
 * (via knoveraContentScript.ts) and the Discord tab it opens/reuses (via
 * discordContentScript.ts) — this is the ONLY module that ever calls
 * `chrome.tabs.create`/`chrome.tabs.update` to navigate to a Discord
 * channel, and it does so only in direct response to an explicit
 * SCAN_START request that originated from the user clicking "Scan
 * Channel" in Knovera. Holds no Knovera credentials (none are ever sent
 * to it — see knoveraContentScript.ts's doc comment) and no Discord
 * credentials (it never reads cookies/tokens; it only opens/reloads a tab
 * and exchanges structured messages with the content script running
 * inside it). Requires live-browser validation — chrome.tabs/chrome.runtime
 * don't exist in a unit-test environment; the readiness retry/recovery
 * logic itself lives in discordTabReadiness.ts and IS unit-tested there.
 */
import { MESSAGE_MARKER, PROTOCOL_VERSION, isToExtensionMessage, isDiscordTabEvent, isReadyResponse, type ToPageMessage } from "./bridgeProtocol.js";
import { ensureDiscordTabReady, type ReadinessProbe } from "./discordTabReadiness.js";

interface PendingScan {
  knoveraTabId: number;
  discordTabId: number;
}

const pendingScans = new Map<string, PendingScan>();
// A SCAN_CANCEL that arrives while a scan is still opening/reloading/
// waiting-on-readiness for its Discord tab — before it has an entry in
// pendingScans — is recorded here instead of silently dropped; checked
// once handleScanStart reaches the point where it would otherwise send
// START_SCAN.
const cancelledBeforeStart = new Set<string>();

function sendToKnoveraTab(tabId: number, message: ToPageMessage): void {
  chrome.tabs.sendMessage(tabId, message);
}

function emptyCancelledResult() {
  return { channel: { guildId: "", channelId: "", channelName: null }, occurrences: [], messagesScanned: 0, cancelled: true };
}

interface OpenedDiscordTab {
  tabId: number;
  /** False for a tab this call itself just created — see discordTabReadiness.ts's `isFreshlyOpenedTab` option. */
  reused: boolean;
}

function openOrReuseDiscordTab(channelUrl: string): Promise<OpenedDiscordTab> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: "https://discord.com/*" }, (tabs) => {
      const existing = tabs.find((tab) => tab.url === channelUrl);
      if (existing?.id != null) {
        resolve({ tabId: existing.id, reused: true });
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
          resolve({ tabId, reused: false });
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    });
  });
}

/** Reloads/navigates a tab to the given URL and waits for it to finish loading — used only to recover a reused tab whose content script didn't answer the readiness probe (e.g. it predates the extension being installed/reloaded). */
function reloadDiscordTab(tabId: number, channelUrl: string): Promise<void> {
  return new Promise((resolve) => {
    function onUpdated(updatedTabId: number, changeInfo: { status?: string }) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url: channelUrl });
  });
}

function createDiscordTabReadinessProbe(): ReadinessProbe {
  return {
    probe(tabId: number, timeoutMs: number): Promise<boolean> {
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(false);
        }, timeoutMs);

        chrome.tabs.sendMessage(tabId, { type: "READY_CHECK" }, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Reading chrome.runtime.lastError here is required (Chrome logs
          // an "Unchecked runtime.lastError" warning otherwise) and its
          // presence IS the "no content script listening in this tab"
          // signal — not a real error to surface anywhere.
          const failed = !!chrome.runtime.lastError;
          resolve(!failed && isReadyResponse(response));
        });
      });
    },
  };
}

async function handleScanStart(knoveraTabId: number, requestId: string, channelUrl: string): Promise<void> {
  try {
    const { tabId: discordTabId, reused } = await openOrReuseDiscordTab(channelUrl);

    const ready = await ensureDiscordTabReady(
      { probe: createDiscordTabReadinessProbe(), recover: (tabId) => reloadDiscordTab(tabId, channelUrl) },
      discordTabId,
      { isFreshlyOpenedTab: !reused },
    );

    if (cancelledBeforeStart.delete(requestId)) {
      sendToKnoveraTab(knoveraTabId, {
        [MESSAGE_MARKER]: true,
        direction: "toPage",
        version: PROTOCOL_VERSION,
        type: "SCAN_RESULT",
        requestId,
        result: emptyCancelledResult(),
      });
      return;
    }

    if (!ready) {
      sendToKnoveraTab(knoveraTabId, {
        [MESSAGE_MARKER]: true,
        direction: "toPage",
        version: PROTOCOL_VERSION,
        type: "SCAN_ERROR",
        requestId,
        message: "The Discord tab didn't respond in time. Please make sure you're logged into Discord in that tab and try again.",
      });
      return;
    }

    pendingScans.set(requestId, { knoveraTabId, discordTabId });
    chrome.tabs.sendMessage(discordTabId, { type: "START_SCAN", requestId });
  } catch (err) {
    cancelledBeforeStart.delete(requestId);
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
      if (pending) {
        chrome.tabs.sendMessage(pending.discordTabId, { type: "CANCEL_SCAN", requestId: message.requestId });
      } else {
        // The scan hasn't reached pendingScans yet — still opening/
        // reloading/waiting on its Discord tab's readiness. handleScanStart
        // checks this set right before it would otherwise send START_SCAN.
        cancelledBeforeStart.add(message.requestId);
      }
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
