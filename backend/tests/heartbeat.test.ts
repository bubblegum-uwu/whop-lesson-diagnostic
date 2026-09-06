import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeat } from "../src/worker/heartbeat.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startHeartbeat", () => {
  it("calls renew repeatedly at the given interval", async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = startHeartbeat({ intervalMs: 10, renew });

    await vi.advanceTimersByTimeAsync(35);
    expect(renew).toHaveBeenCalledTimes(3);

    heartbeat.stop();
  });

  it("does not overlap: a slow renew() suppresses ticks due while it is still in flight", async () => {
    let resolveRenew!: (value: boolean) => void;
    const renew = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRenew = resolve;
        }),
    );
    const heartbeat = startHeartbeat({ intervalMs: 10, renew });

    await vi.advanceTimersByTimeAsync(35); // several ticks' worth of time, but renew() never resolved
    expect(renew).toHaveBeenCalledTimes(1);

    resolveRenew(true);
    await vi.advanceTimersByTimeAsync(0); // let the in-flight promise settle
    await vi.advanceTimersByTimeAsync(10);
    expect(renew).toHaveBeenCalledTimes(2);

    heartbeat.stop();
  });

  it("stops calling renew once stop() is called", async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = startHeartbeat({ intervalMs: 10, renew });

    await vi.advanceTimersByTimeAsync(15);
    const callsBeforeStop = renew.mock.calls.length;
    heartbeat.stop();

    await vi.advanceTimersByTimeAsync(50);
    expect(renew).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it("stops itself automatically when renew() resolves false (lease lost)", async () => {
    const renew = vi.fn().mockResolvedValue(false);
    startHeartbeat({ intervalMs: 10, renew });

    await vi.advanceTimersByTimeAsync(15);
    expect(renew).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(50);
    expect(renew).toHaveBeenCalledTimes(1); // never called again after losing the lease
  });

  it("calling stop() twice is a no-op", async () => {
    const renew = vi.fn().mockResolvedValue(true);
    const heartbeat = startHeartbeat({ intervalMs: 10, renew });
    heartbeat.stop();
    expect(() => heartbeat.stop()).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    expect(renew).not.toHaveBeenCalled();
  });

  it("a rejected renew() does not stop the timer (best-effort)", async () => {
    const renew = vi.fn().mockRejectedValue(new Error("transient DB error"));
    const heartbeat = startHeartbeat({ intervalMs: 10, renew });

    await vi.advanceTimersByTimeAsync(35);
    expect(renew.mock.calls.length).toBeGreaterThan(1);

    heartbeat.stop();
  });
});
