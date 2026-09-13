/**
 * Phase 4K-C — the Knovera-page side of the browser companion bridge
 * protocol. The Knovera web app never talks to `chrome.runtime` directly;
 * it only ever exchanges `window.postMessage` messages with a content
 * script the browser companion extension injects into THIS page's own
 * origin (see browser-companion/src/knoveraContentScript.ts). That content
 * script relays to the extension's service worker, which is the only part
 * that ever navigates to or reads discord.com — this file never receives,
 * stores, or sends the Knovera bearer/JWT token; the entire protocol below
 * carries nothing but a channel URL, progress counters, and the final scan
 * results (YouTube URL + Discord guild/channel/message identity + posted
 * timestamp — never a message body, never a username).
 *
 * Every listener checks `event.source === window` — a page's own
 * `postMessage` calls always satisfy this, and a content script running IN
 * this page also posts with `window.postMessage(msg, origin)`, which also
 * satisfies it (content scripts share the page's `window` for this API).
 * This is what keeps an embedded iframe or a compromised third-party
 * script from a different window object from spoofing companion replies.
 */

const MESSAGE_MARKER = "__knoveraCompanion" as const;
const PROTOCOL_VERSION = 1;

export interface DiscordScanOccurrence {
  youtubeUrl: string;
  messageId: string;
  messageUrl: string | null;
  /** ISO-8601 — the Discord MESSAGE's timestamp, never a scan/import time. */
  postedAt: string;
}

export interface DiscordScanChannel {
  guildId: string;
  channelId: string;
  /** Null when the companion couldn't safely derive a channel name from the rendered page — never fabricated. */
  channelName: string | null;
}

export interface DiscordScanProgress {
  scannedMessages: number;
  foundOccurrences: number;
}

export interface DiscordScanResult {
  channel: DiscordScanChannel;
  occurrences: DiscordScanOccurrence[];
  /** Total distinct Discord messages inspected during the scan — the preview's "N Discord messages scanned" line, independent of how many contained a YouTube link. */
  messagesScanned: number;
  /** True when this result came back because the caller cancelled the scan — occurrences collected up to that point are still returned, never discarded. */
  cancelled: boolean;
}

type ToExtensionMessage =
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "PING" }
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "SCAN_START"; requestId: string; channelUrl: string }
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "SCAN_CANCEL"; requestId: string };

type ToPageMessage =
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "PONG" }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_PROGRESS"; requestId: string; progress: DiscordScanProgress }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_RESULT"; requestId: string; result: DiscordScanResult }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_ERROR"; requestId: string; message: string };

function isToPageMessage(data: unknown): data is ToPageMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record[MESSAGE_MARKER] === true && record.direction === "toPage" && typeof record.type === "string";
}

function postToExtension(message: ToExtensionMessage): void {
  window.postMessage(message, window.location.origin);
}

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Pings the content script the browser companion injects into this page's
 * own origin. Resolves `{available: true}` only if a PONG arrives within
 * `timeoutMs` — no companion installed (or not yet loaded) resolves
 * `{available: false}`, never rejects, so the caller can render a clear
 * "Knovera Browser Companion is required" state instead of a generic error.
 */
export function detectDiscordCompanion(timeoutMs = 600): Promise<{ available: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      resolve({ available: false });
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window || !isToPageMessage(event.data) || event.data.type !== "PONG") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve({ available: true });
    }

    window.addEventListener("message", onMessage);
    postToExtension({ [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "PING" });
  });
}

export interface DiscordChannelScanHandle {
  requestId: string;
  result: Promise<DiscordScanResult>;
  /** Posts SCAN_CANCEL — the companion stops scrolling and replies with a normal SCAN_RESULT (cancelled: true) carrying whatever it already collected; never a rejection. */
  cancel: () => void;
}

/**
 * Starts a channel scan via the browser companion. `onProgress` fires for
 * every SCAN_PROGRESS message the companion posts back while it scrolls
 * through the channel's history — purely informational, safe to ignore.
 * The promise rejects only on a genuine scan error (SCAN_ERROR) — never on
 * cancellation, which resolves normally with `cancelled: true`.
 */
export function scanDiscordChannel(channelUrl: string, onProgress?: (progress: DiscordScanProgress) => void): DiscordChannelScanHandle {
  const requestId = randomRequestId();
  let settled = false;

  const result = new Promise<DiscordScanResult>((resolve, reject) => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window || !isToPageMessage(event.data)) return;
      const data = event.data;
      if (!("requestId" in data) || data.requestId !== requestId) return;

      if (data.type === "SCAN_PROGRESS") {
        onProgress?.(data.progress);
        return;
      }
      if (settled) return;
      if (data.type === "SCAN_RESULT") {
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(data.result);
      } else if (data.type === "SCAN_ERROR") {
        settled = true;
        window.removeEventListener("message", onMessage);
        reject(new Error(data.message));
      }
    }
    window.addEventListener("message", onMessage);
  });

  postToExtension({ [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "SCAN_START", requestId, channelUrl });

  return {
    requestId,
    result,
    cancel: () => postToExtension({ [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "SCAN_CANCEL", requestId }),
  };
}

/** Discord channel URL validation — https://discord.com/channels/<guildId>/<channelId>, strict (no @me DMs, no trailing garbage beyond an optional trailing slash). */
export class DiscordChannelUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordChannelUrlParseError";
  }
}

export interface ParsedDiscordChannelUrl {
  guildId: string;
  channelId: string;
}

const DISCORD_CHANNEL_URL_HOSTS = new Set(["discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com"]);

export function parseDiscordChannelUrl(rawUrl: string): ParsedDiscordChannelUrl {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new DiscordChannelUrlParseError("Discord channel URL is required.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DiscordChannelUrlParseError("The provided value is not a valid URL.");
  }

  if (url.protocol !== "https:" || !DISCORD_CHANNEL_URL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DiscordChannelUrlParseError("Expected a https://discord.com/channels/... URL.");
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  // /channels/<guildId>/<channelId> — a message-permalink form
  // (/channels/<guildId>/<channelId>/<messageId>) is also accepted, the
  // trailing message id is simply ignored (channel-level scan either way).
  if (segments.length < 3 || segments[0] !== "channels" || segments[1] === "@me") {
    throw new DiscordChannelUrlParseError("Expected a server channel URL: https://discord.com/channels/<serverId>/<channelId>.");
  }

  const [, guildId, channelId] = segments;
  if (!/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) {
    throw new DiscordChannelUrlParseError("The server and channel ids in this URL don't look valid.");
  }

  return { guildId, channelId };
}
