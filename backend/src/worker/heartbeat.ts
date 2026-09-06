export interface HeartbeatController {
  stop(): void;
}

export interface StartHeartbeatOptions {
  intervalMs: number;
  /** Renews the lease; resolves false when ownership has been lost — the heartbeat stops itself in that case. */
  renew: () => Promise<boolean>;
}

/**
 * Keeps a claimed job's lease/heartbeat alive independently of any pipeline
 * progress callback. This exists because a single long-awaited operation —
 * a Gemini analysis call, a Gemini file-processing poll, an upload — can
 * take minutes and produces no progress event of its own during that time;
 * without an independent timer, `last_heartbeat_at` goes stale even though
 * the worker, the lease, and Gemini are all healthy.
 *
 * Ticks never overlap: if a renewal is still in flight when the next tick
 * is due, that tick is skipped rather than queued or run concurrently.
 * A `renew()` rejection is treated as best-effort and does not stop the
 * timer — only an explicit `false` (lease lost) or calling `stop()` does.
 */
export function startHeartbeat(options: StartHeartbeatOptions): HeartbeatController {
  let stopped = false;
  let inFlight = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    options
      .renew()
      .then((stillHeld) => {
        if (!stillHeld) stop();
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  }, options.intervalMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return { stop };
}
