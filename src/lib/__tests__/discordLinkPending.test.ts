import { describe, it, expect, beforeEach } from "vitest";
import { savePendingDiscordLinkToken, takePendingDiscordLinkToken } from "../discordLinkPending";

beforeEach(() => {
  sessionStorage.clear();
});

describe("discordLinkPending", () => {
  it("round-trips a saved token", () => {
    savePendingDiscordLinkToken("abc123");
    expect(takePendingDiscordLinkToken()).toBe("abc123");
  });

  it("is single-use — a second take returns null", () => {
    savePendingDiscordLinkToken("abc123");
    takePendingDiscordLinkToken();
    expect(takePendingDiscordLinkToken()).toBeNull();
  });

  it("returns null when nothing was ever stashed", () => {
    expect(takePendingDiscordLinkToken()).toBeNull();
  });
});
