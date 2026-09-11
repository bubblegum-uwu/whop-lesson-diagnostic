import { describe, it, expect, vi, afterEach } from "vitest";
import { issueDiscordConnectState, verifyDiscordConnectState } from "../src/lib/discordOAuthState.js";

afterEach(() => {
  vi.useRealTimers();
});

const SECRET = "test-discord-state-secret";
const IDENTITY = "knovera-operator";

describe("Discord OAuth connect-state (Phase 4K-B)", () => {
  it("a freshly issued state token verifies successfully and carries back the initiating identity", async () => {
    const state = await issueDiscordConnectState(SECRET, IDENTITY);
    const payload = await verifyDiscordConnectState(state, SECRET);
    expect(payload?.identity).toBe(IDENTITY);
    expect(payload?.jti).toBeTruthy();
  });

  it("rejects a state token signed with a different secret", async () => {
    const state = await issueDiscordConnectState(SECRET, IDENTITY);
    expect(await verifyDiscordConnectState(state, "a-different-secret")).toBeNull();
  });

  it("rejects a tampered state token", async () => {
    const state = await issueDiscordConnectState(SECRET, IDENTITY);
    const tampered = state.slice(0, -2) + (state.slice(-2) === "AA" ? "BB" : "AA");
    expect(await verifyDiscordConnectState(tampered, SECRET)).toBeNull();
  });

  it("rejects an expired state token", async () => {
    const state = await issueDiscordConnectState(SECRET, IDENTITY, 1); // 1 second TTL
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await verifyDiscordConnectState(state, SECRET)).toBeNull();
  });

  it("rejects garbage input without throwing", async () => {
    expect(await verifyDiscordConnectState("not-a-jwt-at-all", SECRET)).toBeNull();
    expect(await verifyDiscordConnectState("", SECRET)).toBeNull();
  });

  it("two calls issue different tokens (unpredictable — real jti/iat, not reused) even for the same identity", async () => {
    const a = await issueDiscordConnectState(SECRET, IDENTITY);
    const b = await issueDiscordConnectState(SECRET, IDENTITY);
    expect(a).not.toBe(b);
    const [payloadA, payloadB] = await Promise.all([verifyDiscordConnectState(a, SECRET), verifyDiscordConnectState(b, SECRET)]);
    expect(payloadA?.jti).not.toBe(payloadB?.jti);
  });

  it("two different initiating identities produce state tokens that carry back their own identity, never each other's", async () => {
    const stateA = await issueDiscordConnectState(SECRET, "identity-a");
    const stateB = await issueDiscordConnectState(SECRET, "identity-b");
    expect((await verifyDiscordConnectState(stateA, SECRET))?.identity).toBe("identity-a");
    expect((await verifyDiscordConnectState(stateB, SECRET))?.identity).toBe("identity-b");
  });
});
