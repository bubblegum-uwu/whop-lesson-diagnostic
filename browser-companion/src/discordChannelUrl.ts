/**
 * Discord channel URL parsing — used by discordContentScript.ts to read
 * the guild/channel identity out of `window.location` once the scan
 * starts (never used to construct a URL to navigate to arbitrary
 * locations; only to interpret the tab the user/Knovera already opened).
 */

export class DiscordChannelUrlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordChannelUrlParseError";
  }
}

export interface ParsedDiscordChannelUrl {
  guildId: string;
  channelId: string;
}

const DISCORD_CHANNEL_URL_HOSTS = new Set(["discord.com", "www.discord.com", "canary.discord.com", "ptb.discord.com"]);

export function parseDiscordChannelUrl(rawUrl: string): ParsedDiscordChannelUrl {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed.length === 0) {
    throw new DiscordChannelUrlParseError("Discord channel URL is required.");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DiscordChannelUrlParseError("The provided value is not a valid URL.");
  }
  if (url.protocol !== "https:" || !DISCORD_CHANNEL_URL_HOSTS.has(url.hostname.toLowerCase())) {
    throw new DiscordChannelUrlParseError("Expected a https://discord.com/channels/... URL.");
  }
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 3 || segments[0] !== "channels" || segments[1] === "@me") {
    throw new DiscordChannelUrlParseError("Expected a server channel URL: https://discord.com/channels/<serverId>/<channelId>.");
  }
  const [, guildId, channelId] = segments;
  if (!guildId || !channelId || !/^\d+$/.test(guildId) || !/^\d+$/.test(channelId)) {
    throw new DiscordChannelUrlParseError("The server and channel ids in this URL don't look valid.");
  }
  return { guildId, channelId };
}

/** A channel permalink is always safely derivable from ids we already have — never a guess. */
export function buildChannelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/** A message permalink, likewise always safely derivable from ids the scan itself extracted. */
export function buildMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}
