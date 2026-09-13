/**
 * Whether a given Discord tab's content script is actually reachable, and
 * recovering when it isn't — an already-open Discord tab can predate the
 * extension being installed/reloaded, so its content script may simply
 * never have been injected. Pure and dependency-injected (no `chrome.*`
 * reference in this file) so the retry/timeout/recovery logic is fully
 * unit-testable; `serviceWorker.ts` supplies the real chrome-backed
 * `ReadinessProbe`/recovery callback.
 */

export interface ReadinessProbe {
  /** Resolves true if the tab answered READY within `timeoutMs`, false otherwise — never rejects (a missing/slow content script is an expected, ordinary outcome here, not an error). */
  probe(tabId: number, timeoutMs: number): Promise<boolean>;
}

export interface ReadinessOptions {
  attemptTimeoutMs?: number;
  /** Extra attempts AFTER the first — 0 means "probe exactly once." */
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 1500;
export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_RETRY_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it reports ready, or the retry budget (bounded — never waits forever) runs out. */
export async function waitUntilReady(probe: ReadinessProbe, tabId: number, options: ReadinessOptions = {}): Promise<boolean> {
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (await probe.probe(tabId, attemptTimeoutMs)) return true;
    if (attempt < maxRetries) await sleep(retryDelayMs);
  }
  return false;
}

export interface EnsureReadyDeps {
  probe: ReadinessProbe;
  /** Reloads/navigates the tab so a content script gets (re-)injected — called ONLY when an initial probe on a REUSED tab fails; never called for a tab this extension just opened itself. */
  recover: (tabId: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureReadyOptions extends ReadinessOptions {
  /**
   * True for a tab the caller just created itself (chrome.tabs.create
   * already resolved on "complete") — there is no reason to reload a tab
   * that was never previously open, so this skips straight to the bounded
   * retry loop instead of doing a single cheap probe-then-recover first.
   */
  isFreshlyOpenedTab?: boolean;
}

/**
 * Reused-tab path: one cheap probe first (most reused tabs already have a
 * live content script, so this is the common, fast case) — only reloads
 * the tab (`recover`) if that single probe fails, then retries with the
 * normal bounded budget. Freshly-opened-tab path: skips straight to the
 * bounded retry loop (the content script just needs a moment to run after
 * `document_idle`), since reloading a tab that was only just opened would
 * accomplish nothing.
 */
export async function ensureDiscordTabReady(deps: EnsureReadyDeps, tabId: number, options: EnsureReadyOptions = {}): Promise<boolean> {
  if (!options.isFreshlyOpenedTab) {
    const readyOnFirstTry = await waitUntilReady(deps.probe, tabId, { ...options, maxRetries: 0 });
    if (readyOnFirstTry) return true;
    await deps.recover(tabId);
  }
  return waitUntilReady(deps.probe, tabId, options);
}
