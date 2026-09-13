import type { DiscordScanProgress, DiscordScanResult } from "./types.js";

/**
 * The Knovera-page <-> extension protocol — mirrors
 * src/lib/discordCompanionBridge.ts on the Knovera web app side exactly
 * (same marker, same message shapes). knoveraContentScript.ts is the only
 * module that speaks this protocol over `window.postMessage`; everything
 * past it (serviceWorker.ts, discordContentScript.ts) is internal wiring
 * the Knovera page never sees.
 */
export const MESSAGE_MARKER = "__knoveraCompanion" as const;
export const PROTOCOL_VERSION = 1;

export type ToExtensionMessage =
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "PING" }
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "SCAN_START"; requestId: string; channelUrl: string }
  | { [MESSAGE_MARKER]: true; direction: "toExtension"; version: number; type: "SCAN_CANCEL"; requestId: string };

export type ToPageMessage =
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "PONG" }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_PROGRESS"; requestId: string; progress: DiscordScanProgress }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_RESULT"; requestId: string; result: DiscordScanResult }
  | { [MESSAGE_MARKER]: true; direction: "toPage"; version: number; type: "SCAN_ERROR"; requestId: string; message: string };

export function isToExtensionMessage(data: unknown): data is ToExtensionMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record[MESSAGE_MARKER] === true && record.direction === "toExtension" && typeof record.type === "string";
}

export function isToPageMessage(data: unknown): data is ToPageMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record[MESSAGE_MARKER] === true && record.direction === "toPage" && typeof record.type === "string";
}

/**
 * The internal service-worker <-> Discord-tab-content-script protocol.
 * Never leaves the extension, never reaches the Knovera page — a purely
 * internal wiring detail, kept as its own small vocabulary rather than
 * overloading ToExtensionMessage/ToPageMessage across two very different
 * trust boundaries.
 */
export type DiscordTabCommand = { type: "START_SCAN"; requestId: string } | { type: "CANCEL_SCAN"; requestId: string };

export type DiscordTabEvent =
  | { type: "SCAN_PROGRESS"; requestId: string; progress: DiscordScanProgress }
  | { type: "SCAN_RESULT"; requestId: string; result: DiscordScanResult }
  | { type: "SCAN_ERROR"; requestId: string; message: string };

export function isDiscordTabEvent(data: unknown): data is DiscordTabEvent {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (record.type === "SCAN_PROGRESS" || record.type === "SCAN_RESULT" || record.type === "SCAN_ERROR") && typeof record.requestId === "string";
}

export function isDiscordTabCommand(data: unknown): data is DiscordTabCommand {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return (record.type === "START_SCAN" || record.type === "CANCEL_SCAN") && typeof record.requestId === "string";
}

/**
 * A separate, tiny local-readiness handshake — NOT part of a scan's
 * lifecycle (no requestId), so it's kept out of DiscordTabCommand/
 * DiscordTabEvent above. The service worker sends `ReadyCheckCommand` via
 * `chrome.tabs.sendMessage`'s request/response form and reads the answer
 * straight from that callback (see discordTabReadiness.ts) — a content
 * script that isn't loaded simply never answers, which combined with a
 * bounded timeout is exactly the "is this tab's content script alive"
 * signal (see the Phase 4K-C follow-up fix's doc comments).
 */
export interface ReadyCheckCommand {
  type: "READY_CHECK";
}
export interface ReadyResponse {
  type: "READY";
}

export function isReadyCheckCommand(data: unknown): data is ReadyCheckCommand {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>).type === "READY_CHECK";
}

export function isReadyResponse(data: unknown): data is ReadyResponse {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>).type === "READY";
}
