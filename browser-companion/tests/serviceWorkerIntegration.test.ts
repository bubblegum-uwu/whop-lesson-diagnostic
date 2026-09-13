import { describe, it, expect, vi, afterEach } from "vitest";
import { createFakeChrome } from "./fixtures/fakeChrome.js";
import { MESSAGE_MARKER, PROTOCOL_VERSION } from "../src/bridgeProtocol.js";

const CHANNEL_URL = "https://discord.com/channels/1218766394997346395/1219022089252503632";
const KNOVERA_TAB_ID = 7;

function scanStart(requestId: string, channelUrl = CHANNEL_URL) {
  return { [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "SCAN_START", requestId, channelUrl };
}
function scanCancel(requestId: string) {
  return { [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "SCAN_CANCEL", requestId };
}

async function importFreshServiceWorker() {
  vi.resetModules();
  await import("../src/serviceWorker.js");
}

function readyCheckHandler(message: unknown, sendResponse: (r?: unknown) => void) {
  if ((message as { type?: string }).type === "READY_CHECK") sendResponse({ type: "READY" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serviceWorker.ts — Discord tab readiness + scan routing (integration, fake chrome)", () => {
  it("6: an already-open Discord tab whose content script answers immediately is reused — never reloaded", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    helpers.addExistingTab(42, CHANNEL_URL);
    helpers.registerTabHandler(42, readyCheckHandler);
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);

    await vi.waitFor(
      () => {
        expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string }).type === "START_SCAN")).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
    expect(helpers.tabsReloaded).toEqual([]);
    expect(helpers.tabsCreated).toEqual([]);
  });

  it("7: an already-open tab with no responding content script is recovered via reload, then scanned", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    helpers.addExistingTab(42, CHANNEL_URL);
    // No handler registered yet — the content script "isn't there."
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);

    await vi.waitFor(
      () => {
        expect(helpers.tabsReloaded).toEqual([{ tabId: 42, url: CHANNEL_URL }]);
      },
      { timeout: 4000, interval: 25 },
    );

    // The reload "finishes" once the content script is present and the
    // page reports complete.
    helpers.registerTabHandler(42, readyCheckHandler);
    helpers.fireTabComplete(42);

    await vi.waitFor(
      () => {
        expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string }).type === "START_SCAN")).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
  }, 10000);

  it("8: retries the readiness probe and succeeds once the content script starts responding", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    // A freshly-opened tab (no existing tab registered) — isolates the
    // bounded-retry behavior itself from the separate reload/recovery path
    // (see test 7), which a REUSED tab would also exercise.
    let probeCount = 0;
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);
    await vi.waitFor(() => expect(helpers.tabsCreated).toEqual([{ url: CHANNEL_URL }]), { timeout: 2000, interval: 25 });
    const newTabId = 1;
    helpers.fireTabComplete(newTabId);
    // Answers every probe immediately (never relying on the probe's own
    // hard timeout), but only reports READY from the 3rd probe onward —
    // simulating a listener that takes a couple of retries to attach.
    helpers.registerTabHandler(newTabId, (message, sendResponse) => {
      if ((message as { type?: string }).type !== "READY_CHECK") return;
      probeCount++;
      sendResponse(probeCount >= 3 ? { type: "READY" } : { type: "NOT_YET" });
    });

    await vi.waitFor(
      () => {
        expect(helpers.sentToTabs.some((t) => t.tabId === newTabId && (t.message as { type?: string }).type === "START_SCAN")).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
    expect(probeCount).toBeGreaterThanOrEqual(3);
    expect(helpers.tabsReloaded).toEqual([]);
  }, 10000);

  it("9: a tab that never becomes ready (even after reload) reports SCAN_ERROR to the Knovera tab, never START_SCAN", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    helpers.addExistingTab(42, CHANNEL_URL);
    // No handler is ever registered — the content script never answers,
    // even once the reload "completes."
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);
    await vi.waitFor(() => expect(helpers.tabsReloaded).toEqual([{ tabId: 42, url: CHANNEL_URL }]), { timeout: 4000, interval: 25 });
    helpers.fireTabComplete(42);

    await vi.waitFor(
      () => {
        const errorSent = helpers.sentToTabs.find(
          (t) => t.tabId === KNOVERA_TAB_ID && (t.message as { type?: string }).type === "SCAN_ERROR",
        );
        expect(errorSent).toBeDefined();
      },
      { timeout: 4000, interval: 25 },
    );
    expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string }).type === "START_SCAN")).toBe(false);
  }, 10000);

  it("10: a newly-opened Discord tab waits for readiness before START_SCAN, without ever reloading", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    // No existing tab — the service worker must create one.
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);

    await vi.waitFor(() => expect(helpers.tabsCreated).toEqual([{ url: CHANNEL_URL }]), { timeout: 2000, interval: 25 });
    const newTabId = 1;
    helpers.fireTabComplete(newTabId);
    // Content script only becomes reachable once the fresh tab is done "loading."
    helpers.registerTabHandler(newTabId, readyCheckHandler);

    await vi.waitFor(
      () => {
        expect(helpers.sentToTabs.some((t) => t.tabId === newTabId && (t.message as { type?: string }).type === "START_SCAN")).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
    expect(helpers.tabsReloaded).toEqual([]);
  }, 10000);

  it("11a: SCAN_CANCEL after a scan has started reaches the correct Discord tab", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    helpers.addExistingTab(42, CHANNEL_URL);
    helpers.registerTabHandler(42, readyCheckHandler);
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);
    await vi.waitFor(
      () => expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string }).type === "START_SCAN")).toBe(true),
      { timeout: 4000, interval: 25 },
    );

    helpers.dispatchRuntimeMessage(scanCancel("req-1"), KNOVERA_TAB_ID);

    expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string; requestId?: string }).type === "CANCEL_SCAN" && (t.message as { requestId?: string }).requestId === "req-1")).toBe(true);
  });

  it("11b: SCAN_CANCEL that arrives before the Discord tab is ready reports a clean cancelled result instead of starting the scan", async () => {
    const { chrome, helpers } = createFakeChrome();
    vi.stubGlobal("chrome", chrome);
    helpers.addExistingTab(42, CHANNEL_URL);
    // No handler yet -> this scan will be stuck in the readiness/reload phase when the cancel arrives.
    await importFreshServiceWorker();

    helpers.dispatchRuntimeMessage(scanStart("req-1"), KNOVERA_TAB_ID);
    await vi.waitFor(() => expect(helpers.tabsReloaded.length).toBe(1), { timeout: 4000, interval: 25 });

    // Cancel arrives while still waiting on readiness — recorded, not dropped.
    helpers.dispatchRuntimeMessage(scanCancel("req-1"), KNOVERA_TAB_ID);

    // Readiness eventually succeeds (reload completed, content script now present)...
    helpers.registerTabHandler(42, readyCheckHandler);
    helpers.fireTabComplete(42);

    // ...but because it was cancelled, the service worker must report a
    // cancelled SCAN_RESULT to Knovera instead of ever sending START_SCAN.
    await vi.waitFor(
      () => {
        const result = helpers.sentToTabs.find(
          (t) => t.tabId === KNOVERA_TAB_ID && (t.message as { type?: string; requestId?: string }).type === "SCAN_RESULT" && (t.message as { requestId?: string }).requestId === "req-1",
        );
        expect(result).toBeDefined();
      },
      { timeout: 4000, interval: 25 },
    );
    expect(helpers.sentToTabs.some((t) => t.tabId === 42 && (t.message as { type?: string }).type === "START_SCAN")).toBe(false);
  }, 10000);
});
