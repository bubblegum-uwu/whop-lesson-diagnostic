import { describe, it, expect, afterEach } from "vitest";
import { scanChannelMessages, type ScannerEnvironment } from "../src/discordScanner.js";
import { createMessageElement, createMessageList, type FixtureMessage } from "./fixtures/discordDom.js";

const CHANNEL = { guildId: "1218766394997346395", channelId: "1219022089252503632" };

let container: HTMLElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
});

/**
 * Builds a fake scanner environment whose `scrollOlder()` reveals the next
 * "page" of fixture messages by appending them to the live DOM container —
 * simulating Discord's virtualized history loading more (older) messages
 * as the user/companion scrolls up. `pages[0]` is what's rendered before
 * the first cycle even begins (mirroring the channel already showing its
 * most-recent messages when the scan starts).
 */
function createFakeEnv(pages: FixtureMessage[][], opts: { cancelAfterPage?: number } = {}) {
  container = createMessageList(document, pages[0] ?? []);
  document.body.appendChild(container);
  let pageIndex = 0;
  let cancelled = false;

  const env: ScannerEnvironment = {
    getRoot: () => container!,
    scrollOlder: () => {
      pageIndex++;
      const next = pages[pageIndex];
      if (next) {
        for (const msg of next) container!.appendChild(createMessageElement(document, msg));
      }
      if (opts.cancelAfterPage != null && pageIndex >= opts.cancelAfterPage) {
        cancelled = true;
      }
    },
    wait: () => Promise.resolve(),
    isCancelled: () => cancelled,
  };
  return env;
}

const YT_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const YT_B = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
const YT_C = "https://www.youtube.com/watch?v=ccccccccccc";

// Realistic-length (Discord snowflake-shaped) message ids — the adapter's
// id-extraction regex deliberately requires 15-25 digits (see
// discordAdapter.ts) to avoid false-positive matches, so fixtures use ids
// shaped like the real thing rather than short mnemonic strings.
const M1 = "1219022089252500001";
const M2 = "1219022089252500002";
const M3 = "1219022089252500003";

describe("scanChannelMessages", () => {
  it("5: virtualization — a message re-rendered in a later cycle is never counted or collected twice", async () => {
    const env = createFakeEnv([
      [{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] }],
      // M1 reappears in this later page (Discord's own virtualization can
      // re-render the same element/id across cycles) alongside a genuinely
      // new message.
      [
        { messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] },
        { messageId: M2, postedAt: "2026-09-12T14:05:00.000Z" },
      ],
    ]);
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 2 });

    expect(result.messagesScanned).toBe(2);
    expect(result.occurrences.filter((o) => o.messageId === M1)).toHaveLength(1);
  });

  it("6: multiple YouTube links in one message produce one occurrence per link, all under that message's id", async () => {
    const env = createFakeEnv([[{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A, YT_B] }]]);
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 1 });

    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.every((o) => o.messageId === M1)).toBe(true);
    expect(result.occurrences.map((o) => o.youtubeUrl).sort()).toEqual([YT_A, YT_B].sort());
  });

  it("7: the same YouTube video posted in two different messages preserves both occurrences", async () => {
    const env = createFakeEnv([
      [
        { messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] },
        { messageId: M2, postedAt: "2026-09-12T15:00:00.000Z", hrefs: [YT_A] },
      ],
    ]);
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 1 });

    const forA = result.occurrences.filter((o) => o.youtubeUrl === YT_A);
    expect(forA).toHaveLength(2);
    expect(forA.map((o) => o.messageId).sort()).toEqual([M1, M2].sort());
  });

  it("8: deterministic no-progress termination — stops after N consecutive cycles with no newly-seen message", async () => {
    const env = createFakeEnv([[{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z" }]]);
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 3, maxCycles: 100 });

    // 1 message total, no further pages — the loop must conclude on its
    // own via the no-progress condition, never by exhausting maxCycles.
    expect(result.messagesScanned).toBe(1);
    expect(result.cancelled).toBe(false);
  });

  it("9: explicit cancellation stops the scan promptly and returns whatever was already collected (never a rejection)", async () => {
    const env = createFakeEnv(
      [
        [{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] }],
        [{ messageId: M2, postedAt: "2026-09-12T14:05:00.000Z", hrefs: [YT_B] }],
        [{ messageId: M3, postedAt: "2026-09-12T14:10:00.000Z", hrefs: [YT_C] }],
      ],
      { cancelAfterPage: 1 },
    );
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 10, maxCycles: 100 });

    expect(result.cancelled).toBe(true);
    // Cancellation is checked at the very top of each cycle, before any
    // processing — so "m1" (already processed in the first, completed
    // cycle) is collected, but "m2" (only just revealed by the scroll that
    // set the cancel flag, never processed) and "m3" are not. Stopping
    // promptly on the next check beats processing one more page first.
    expect(result.occurrences.map((o) => o.youtubeUrl)).toEqual([YT_A]);
    expect(result.messagesScanned).toBe(1);
  });

  it("derives messageUrl safely from the channel identity + message id — never a fabricated link", async () => {
    const env = createFakeEnv([[{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] }]]);
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 1 });

    expect(result.occurrences[0]!.messageUrl).toBe(`https://discord.com/channels/${CHANNEL.guildId}/${CHANNEL.channelId}/${M1}`);
  });

  it("reports progress after every cycle", async () => {
    const env = createFakeEnv([[{ messageId: M1, postedAt: "2026-09-12T14:00:00.000Z", hrefs: [YT_A] }]]);
    const progressReports: { scannedMessages: number; foundOccurrences: number }[] = [];
    env.onProgress = (p) => progressReports.push(p);

    await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 2 });

    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[0]).toEqual({ scannedMessages: 1, foundOccurrences: 1 });
  });

  it("a message missing a timestamp is skipped, never crashes the scan", async () => {
    container = document.createElement("div");
    container.setAttribute("data-list-id", "chat-messages");
    const brokenLi = document.createElement("li");
    brokenLi.setAttribute("data-list-item-id", "chat-messages___chat-messages-12345678901234567");
    container.appendChild(brokenLi);
    document.body.appendChild(container);

    const env: ScannerEnvironment = {
      getRoot: () => container!,
      scrollOlder: () => {},
      wait: () => Promise.resolve(),
      isCancelled: () => false,
    };
    const result = await scanChannelMessages(env, CHANNEL, { maxCyclesWithNoProgress: 2 });
    expect(result.messagesScanned).toBe(0);
    expect(result.occurrences).toEqual([]);
  });
});
