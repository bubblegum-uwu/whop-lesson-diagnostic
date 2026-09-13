/**
 * Phase 4K-C — types shared across the companion's own modules. Mirrors
 * (does not import — this is a separate npm package, same "no shared
 * package" convention as backend/src/lib/youtubeUrl.ts vs.
 * src/lib/youtubeUrl.ts) the protocol shapes in
 * src/lib/discordCompanionBridge.ts on the Knovera web app side.
 */

export interface DiscordScanOccurrence {
  youtubeUrl: string;
  messageId: string;
  /** A safely-derived channel permalink (https://discord.com/channels/<guild>/<channel>/<message>) — never a guess, always built from the same ids the occurrence itself carries. */
  messageUrl: string | null;
  /** ISO-8601 — the Discord MESSAGE's own timestamp, read from its rendered <time datetime> element. Never a scan/import time. */
  postedAt: string;
}

export interface DiscordScanChannel {
  guildId: string;
  channelId: string;
  /** Null when a channel name couldn't be safely read from the page — never fabricated. */
  channelName: string | null;
}

export interface DiscordScanProgress {
  scannedMessages: number;
  foundOccurrences: number;
}

export interface DiscordScanResult {
  channel: DiscordScanChannel;
  occurrences: DiscordScanOccurrence[];
  messagesScanned: number;
  cancelled: boolean;
}
