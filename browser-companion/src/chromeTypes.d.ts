/**
 * Minimal ambient declarations for the small slice of the `chrome.*`
 * extension API this companion actually uses — deliberately NOT the full
 * @types/chrome package (this sandboxed dev environment has no npm
 * registry access to install it, and a hand-picked minimal surface also
 * makes exactly what this extension touches auditable at a glance). Only
 * `serviceWorker.ts`, `discordContentScript.ts`, and `knoveraContentScript.ts`
 * reference these — every other module is plain DOM/TypeScript, testable
 * without any `chrome` global at all.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: { id?: number };
    }
    const onMessage: {
      addListener(
        callback: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
      ): void;
    };
    function sendMessage(message: unknown, callback?: (response?: unknown) => void): void;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      status?: string;
    }
    function query(queryInfo: { url?: string | string[] }, callback: (tabs: Tab[]) => void): void;
    function create(createProperties: { url: string; active?: boolean }, callback?: (tab: Tab) => void): void;
    function update(tabId: number, updateProperties: { url?: string; active?: boolean }, callback?: (tab?: Tab) => void): void;
    function sendMessage(tabId: number, message: unknown, callback?: (response?: unknown) => void): void;
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void): void;
      removeListener(callback: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void): void;
    };
  }
}
