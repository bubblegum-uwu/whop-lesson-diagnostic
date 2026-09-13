import { describe, it, expect } from "vitest";
import { MESSAGE_MARKER, PROTOCOL_VERSION, isToExtensionMessage, isToPageMessage, isDiscordTabCommand, isDiscordTabEvent } from "../src/bridgeProtocol.js";

describe("bridge protocol message guards", () => {
  it("isToExtensionMessage accepts a well-formed SCAN_START", () => {
    const message = { [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "SCAN_START", requestId: "r1", channelUrl: "https://discord.com/channels/1/2" };
    expect(isToExtensionMessage(message)).toBe(true);
  });

  it("10: rejects an arbitrary page message with no companion marker — the extension never reacts to unrelated window.postMessage traffic", () => {
    expect(isToExtensionMessage({ type: "SCAN_START", requestId: "r1", channelUrl: "https://discord.com/channels/1/2" })).toBe(false);
    expect(isToExtensionMessage({ someOtherLibrary: true, type: "SCAN_START" })).toBe(false);
    expect(isToExtensionMessage("just a string")).toBe(false);
    expect(isToExtensionMessage(null)).toBe(false);
    expect(isToExtensionMessage(undefined)).toBe(false);
  });

  it("isToPageMessage rejects a message tagged toExtension (direction must match)", () => {
    const message = { [MESSAGE_MARKER]: true, direction: "toExtension", version: PROTOCOL_VERSION, type: "PING" };
    expect(isToPageMessage(message)).toBe(false);
  });

  it("isDiscordTabCommand only recognizes START_SCAN/CANCEL_SCAN — a Discord content script never runs an unrecognized command", () => {
    expect(isDiscordTabCommand({ type: "START_SCAN", requestId: "r1" })).toBe(true);
    expect(isDiscordTabCommand({ type: "CANCEL_SCAN", requestId: "r1" })).toBe(true);
    expect(isDiscordTabCommand({ type: "SOMETHING_ELSE", requestId: "r1" })).toBe(false);
    expect(isDiscordTabCommand({ requestId: "r1" })).toBe(false);
    expect(isDiscordTabCommand("not an object")).toBe(false);
  });

  it("isDiscordTabEvent only recognizes SCAN_PROGRESS/SCAN_RESULT/SCAN_ERROR, each requiring a requestId", () => {
    expect(isDiscordTabEvent({ type: "SCAN_PROGRESS", requestId: "r1", progress: { scannedMessages: 1, foundOccurrences: 0 } })).toBe(true);
    expect(isDiscordTabEvent({ type: "SCAN_RESULT", requestId: "r1", result: {} })).toBe(true);
    expect(isDiscordTabEvent({ type: "SCAN_ERROR", requestId: "r1", message: "x" })).toBe(true);
    expect(isDiscordTabEvent({ type: "SCAN_RESULT" })).toBe(false);
    expect(isDiscordTabEvent({ type: "UNKNOWN", requestId: "r1" })).toBe(false);
  });
});
