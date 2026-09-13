import { findRenderedMessageElements, adaptMessageElement } from "./discordAdapter.js";
import { extractYouTubeUrls } from "./youtubeLinkExtractor.js";
import { buildMessageUrl } from "./discordChannelUrl.js";
import { tryCanonicalizeYouTubeVideoId } from "./youtubeUrl.js";
import type { DiscordScanOccurrence, DiscordScanProgress } from "./types.js";

/**
 * Everything the scan loop needs from the outside world, injected so this
 * module is fully unit-testable against DOM fixtures — no live Discord,
 * no real timers, no chrome.* APIs. The real caller (discordContentScript.ts)
 * supplies an environment backed by `document`, a real scroll/settle
 * delay, and a cancellation flag toggled by an incoming SCAN_CANCEL
 * message; tests supply a fixture DOM and a synchronous/fast `wait`.
 */
export interface ScannerEnvironment {
  /** The current root to query rendered message elements from (e.g. `document`, or a fixture container in tests). */
  getRoot: () => ParentNode;
  /** Scrolls further into (older) history — real impl moves the scroller's scrollTop toward 0; tests mutate the fixture to reveal more elements. */
  scrollOlder: () => void;
  /** Waits for newly-scrolled-in messages to render before the next inspection pass. */
  wait: () => Promise<void>;
  /** Polled at the top of every cycle — scanning stops promptly once true, keeping whatever was already collected. */
  isCancelled: () => boolean;
  onProgress?: (progress: DiscordScanProgress) => void;
}

export interface ScanChannelIdentity {
  guildId: string;
  channelId: string;
}

export interface ScanOptions {
  /** Consecutive cycles with zero newly-seen messages before concluding "reached the oldest accessible history" (the deterministic no-progress termination condition). */
  maxCyclesWithNoProgress?: number;
  /** An absolute safety cap on cycles, independent of the no-progress check — guards against an environment that keeps reporting (spurious) progress forever. */
  maxCycles?: number;
}

export interface ScanChannelMessagesResult {
  occurrences: DiscordScanOccurrence[];
  messagesScanned: number;
  cancelled: boolean;
}

const DEFAULT_MAX_NO_PROGRESS_CYCLES = 3;
const DEFAULT_MAX_CYCLES = 500;

/**
 * The scan loop: repeatedly inspect currently-rendered messages (skipping
 * any message id already seen — Discord's virtualization means the SAME
 * element/id can reappear across cycles), collect YouTube occurrences,
 * then scroll toward older history and wait for it to render. Stops when:
 * cancelled (`isCancelled()` — the caller's collected occurrences are
 * still returned, never discarded), `maxCyclesWithNoProgress` consecutive
 * cycles yield no newly-seen message (the oldest accessible history has
 * been reached), or the absolute `maxCycles` safety cap is hit.
 */
export async function scanChannelMessages(
  env: ScannerEnvironment,
  channel: ScanChannelIdentity,
  options: ScanOptions = {},
): Promise<ScanChannelMessagesResult> {
  const maxNoProgress = options.maxCyclesWithNoProgress ?? DEFAULT_MAX_NO_PROGRESS_CYCLES;
  const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES;

  const seenMessageIds = new Set<string>();
  const occurrences: DiscordScanOccurrence[] = [];
  let noProgressCycles = 0;
  let cancelled = false;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    if (env.isCancelled()) {
      cancelled = true;
      break;
    }

    const elements = findRenderedMessageElements(env.getRoot());
    let newThisCycle = 0;
    for (const el of elements) {
      const adapted = adaptMessageElement(el);
      if (!adapted || seenMessageIds.has(adapted.messageId)) continue;
      seenMessageIds.add(adapted.messageId);
      newThisCycle++;

      // Same-message dedup (issue: Discord commonly renders the same
      // YouTube link twice within one message — the original inline
      // anchor plus a separate embed/preview anchor for the identical
      // video). Keyed by CANONICAL video id, never the raw href, so
      // watch/shorts/live/youtu.be forms and tracking-param variants of
      // the same video collapse to one occurrence here too — matching
      // exactly what the backend would canonicalize them to anyway. This
      // is purely a same-message concern: a different message id (a
      // repost, or the same video posted in a different channel) always
      // gets its own occurrence, never merged with this one.
      const seenVideoKeysInMessage = new Set<string>();
      for (const youtubeUrl of extractYouTubeUrls(adapted.anchorHrefs)) {
        const dedupeKey = tryCanonicalizeYouTubeVideoId(youtubeUrl) ?? youtubeUrl;
        if (seenVideoKeysInMessage.has(dedupeKey)) continue;
        seenVideoKeysInMessage.add(dedupeKey);

        occurrences.push({
          youtubeUrl,
          messageId: adapted.messageId,
          messageUrl: buildMessageUrl(channel.guildId, channel.channelId, adapted.messageId),
          postedAt: adapted.postedAt,
        });
      }
    }

    env.onProgress?.({ scannedMessages: seenMessageIds.size, foundOccurrences: occurrences.length });

    if (newThisCycle === 0) {
      noProgressCycles++;
      if (noProgressCycles >= maxNoProgress) break;
    } else {
      noProgressCycles = 0;
    }

    if (env.isCancelled()) {
      cancelled = true;
      break;
    }

    env.scrollOlder();
    await env.wait();
  }

  return { occurrences, messagesScanned: seenMessageIds.size, cancelled };
}
