import { describe, it, expect, vi } from "vitest";
import { waitUntilReady, ensureDiscordTabReady, type ReadinessProbe } from "../src/discordTabReadiness.js";

function instantSleep() {
  return Promise.resolve();
}

describe("waitUntilReady", () => {
  it("resolves true immediately when the first probe succeeds", async () => {
    const probe: ReadinessProbe = { probe: vi.fn(async () => true) };
    const result = await waitUntilReady(probe, 1, { sleep: instantSleep });
    expect(result).toBe(true);
    expect(probe.probe).toHaveBeenCalledTimes(1);
  });

  it("8: retries after failed probes and succeeds once one finally answers", async () => {
    let calls = 0;
    const probe: ReadinessProbe = {
      probe: vi.fn(async () => {
        calls++;
        return calls >= 3;
      }),
    };
    const result = await waitUntilReady(probe, 1, { maxRetries: 5, sleep: instantSleep });
    expect(result).toBe(true);
    expect(probe.probe).toHaveBeenCalledTimes(3);
  });

  it("9: gives up (bounded) once the retry budget is exhausted — never waits forever", async () => {
    const probe: ReadinessProbe = { probe: vi.fn(async () => false) };
    const result = await waitUntilReady(probe, 1, { maxRetries: 3, sleep: instantSleep });
    expect(result).toBe(false);
    expect(probe.probe).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("sleeps between retries but not after the final attempt", async () => {
    const sleep = vi.fn(async () => {});
    const probe: ReadinessProbe = { probe: vi.fn(async () => false) };
    await waitUntilReady(probe, 1, { maxRetries: 2, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("ensureDiscordTabReady", () => {
  it("6: an already-open tab whose content script answers immediately is used as-is — recover() is never called", async () => {
    const probe: ReadinessProbe = { probe: vi.fn(async () => true) };
    const recover = vi.fn(async () => {});
    const result = await ensureDiscordTabReady({ probe, recover, sleep: instantSleep }, 42);
    expect(result).toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });

  it("7: an already-open tab with no responding content script triggers recover(), then succeeds", async () => {
    let recovered = false;
    const probe: ReadinessProbe = {
      probe: vi.fn(async () => recovered),
    };
    const recover = vi.fn(async () => {
      recovered = true;
    });
    const result = await ensureDiscordTabReady({ probe, recover, sleep: instantSleep }, 42);
    expect(result).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(42);
  });

  it("a tab that never becomes ready even after recovery resolves false (never throws)", async () => {
    const probe: ReadinessProbe = { probe: vi.fn(async () => false) };
    const recover = vi.fn(async () => {});
    const result = await ensureDiscordTabReady({ probe, recover, sleep: instantSleep }, 42, { maxRetries: 2 });
    expect(result).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("10: a freshly-opened tab skips the probe-then-recover step and goes straight to the bounded retry loop", async () => {
    let calls = 0;
    const probe: ReadinessProbe = {
      probe: vi.fn(async () => {
        calls++;
        return calls >= 2;
      }),
    };
    const recover = vi.fn(async () => {});
    const result = await ensureDiscordTabReady({ probe, recover, sleep: instantSleep }, 99, { isFreshlyOpenedTab: true, maxRetries: 5 });
    expect(result).toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });
});
