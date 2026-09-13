/**
 * A minimal, in-memory stand-in for the `chrome.*` surface serviceWorker.ts
 * uses — just enough to drive its actual message-routing/readiness/
 * recovery logic under test, without a real browser. Models the real
 * split faithfully: `chrome.tabs.sendMessage` is the service worker
 * calling INTO a tab's content script (with a per-tab handler standing in
 * for "is a content script listening"); `chrome.runtime.onMessage` is the
 * service worker's own inbox for messages a content script sends UP via
 * `chrome.runtime.sendMessage` (simulated here via `dispatchRuntimeMessage`).
 */
import { vi } from "vitest";

export interface FakeTab {
  id: number;
  url: string;
}

export function createFakeChrome() {
  const tabsById = new Map<number, FakeTab>();
  const tabHandlers = new Map<number, (message: unknown, sendResponse: (response?: unknown) => void) => void>();
  const onUpdatedListeners: Array<(tabId: number, changeInfo: { status?: string }, tab: FakeTab) => void> = [];
  const runtimeListeners: Array<(message: unknown, sender: { tab?: { id?: number } }, sendResponse: (r?: unknown) => void) => void> = [];
  let nextTabId = 1;
  let lastError: { message?: string } | undefined;

  const sentToTabs: Array<{ tabId: number; message: unknown }> = [];
  const tabsCreated: Array<{ url: string }> = [];
  const tabsReloaded: Array<{ tabId: number; url: string }> = [];

  const chrome = {
    tabs: {
      query(_queryInfo: unknown, callback: (tabs: FakeTab[]) => void) {
        callback([...tabsById.values()]);
      },
      create(props: { url: string }, callback: (tab: FakeTab) => void) {
        const tab: FakeTab = { id: nextTabId++, url: props.url };
        tabsById.set(tab.id, tab);
        tabsCreated.push({ url: props.url });
        callback(tab);
      },
      update(tabId: number, props: { url?: string }, callback?: (tab?: FakeTab) => void) {
        const tab = tabsById.get(tabId);
        if (tab && props.url) {
          tab.url = props.url;
          tabsReloaded.push({ tabId, url: props.url });
        }
        callback?.(tab);
      },
      sendMessage(tabId: number, message: unknown, callback?: (response?: unknown) => void) {
        sentToTabs.push({ tabId, message });
        const handler = tabHandlers.get(tabId);
        lastError = undefined;
        if (handler) {
          handler(message, (response) => callback?.(response));
        } else {
          lastError = { message: "Could not establish connection. Receiving end does not exist." };
          callback?.(undefined);
        }
      },
      onUpdated: {
        addListener(fn: (tabId: number, changeInfo: { status?: string }, tab: FakeTab) => void) {
          onUpdatedListeners.push(fn);
        },
        removeListener(fn: (tabId: number, changeInfo: { status?: string }, tab: FakeTab) => void) {
          const i = onUpdatedListeners.indexOf(fn);
          if (i >= 0) onUpdatedListeners.splice(i, 1);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(fn: (message: unknown, sender: { tab?: { id?: number } }, sendResponse: (r?: unknown) => void) => void) {
          runtimeListeners.push(fn);
        },
      },
      sendMessage: vi.fn(),
      get lastError() {
        return lastError;
      },
    },
  };

  return {
    chrome,
    helpers: {
      /** Registers an existing (pre-opened) Discord tab at the given url/id. */
      addExistingTab(id: number, url: string) {
        tabsById.set(id, { id, url });
      },
      /** Simulates a content script being present/injected in a tab and answering whatever the service worker sends it. */
      registerTabHandler(tabId: number, handler: (message: unknown, sendResponse: (response?: unknown) => void) => void) {
        tabHandlers.set(tabId, handler);
      },
      removeTabHandler(tabId: number) {
        tabHandlers.delete(tabId);
      },
      /** Fires the onUpdated "complete" event for a tab (simulating page load finishing after tabs.create or tabs.update). */
      fireTabComplete(tabId: number) {
        const tab = tabsById.get(tabId);
        if (!tab) throw new Error(`No fake tab ${tabId}`);
        for (const fn of [...onUpdatedListeners]) fn(tabId, { status: "complete" }, tab);
      },
      /** Simulates a message arriving at the service worker's chrome.runtime.onMessage inbox, as if sent (via chrome.runtime.sendMessage) from the given tab. */
      dispatchRuntimeMessage(message: unknown, fromTabId?: number) {
        for (const fn of runtimeListeners) fn(message, { tab: fromTabId != null ? { id: fromTabId } : undefined }, () => {});
      },
      sentToTabs,
      tabsCreated,
      tabsReloaded,
    },
  };
}
