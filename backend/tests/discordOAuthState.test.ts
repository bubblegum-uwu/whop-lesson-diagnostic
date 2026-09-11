import { describe, it, expect, vi, afterEach } from "vitest";
import { issueDiscordConnectState, verifyDiscordConnectState } from "../src/lib/discordOAuthState.js";

afterEach(() => {
  vi.useRealTimers();
});

const SECRET = "test-discord-state-secret";

describe("Discord OAuth connect-state (Phase 4K-B)", () => {
  it("a freshly issued state token verifies successfully", async () => {
    const state = await issueDiscordConnectState(SECRET);
    expect(await verifyDiscordConnectState(state, SECRET)).toBe(true);
  });

  it("rejects a state token signed with a different secret", async () => {
    const state = await issueDiscordConnectState(SECRET);
    expect(await verifyDiscordConnectState(state, "a-different-secret")).toBe(false);
  });

  it("rejects a tampered state token", async () => {
    const state = await issueDiscordConnectState(SECRET);
    const tampered = state.slice(0, -2) + (state.slice(-2) === "AA" ? "BB" : "AA");
    expect(await verifyDiscordConnectState(tampered, SECRET)).toBe(false);
  });

  it("rejects an expired state token", async () => {
    const state = await issueDiscordConnectState(SECRET, 1); // 1 second TTL
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await verifyDiscordConnectState(state, SECRET)).toBe(false);
  });

  it("rejects garbage input without throwing", async () => {
    expect(await verifyDiscordConnectState("not-a-jwt-at-all", SECRET)).toBe(false);
    expect(await verifyDiscordConnectState("", SECRET)).toBe(false);
  });

  it("two calls issue different tokens (unpredictable — real jti/iat, not reused)", async () => {
    const a = await issueDiscordConnectState(SECRET);
    const b = await issueDiscordConnectState(SECRET);
    expect(a).not.toBe(b);
  });
});
