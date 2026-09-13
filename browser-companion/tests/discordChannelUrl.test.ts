import { describe, it, expect } from "vitest";
import { parseDiscordChannelUrl, DiscordChannelUrlParseError, buildChannelUrl, buildMessageUrl } from "../src/discordChannelUrl.js";

describe("parseDiscordChannelUrl", () => {
  it("1: parses a valid server channel URL", () => {
    const result = parseDiscordChannelUrl("https://discord.com/channels/1218766394997346395/1219022089252503632");
    expect(result).toEqual({ guildId: "1218766394997346395", channelId: "1219022089252503632" });
  });

  it("ignores a trailing message-id segment (a message permalink still scans the whole channel)", () => {
    const result = parseDiscordChannelUrl("https://discord.com/channels/1218766394997346395/1219022089252503632/1219022089252503999");
    expect(result).toEqual({ guildId: "1218766394997346395", channelId: "1219022089252503632" });
  });

  it("rejects a DM (@me) URL", () => {
    expect(() => parseDiscordChannelUrl("https://discord.com/channels/@me/1219022089252503632")).toThrow(DiscordChannelUrlParseError);
  });

  it("rejects a non-Discord host", () => {
    expect(() => parseDiscordChannelUrl("https://example.com/channels/1/2")).toThrow(DiscordChannelUrlParseError);
  });

  it("rejects non-numeric ids", () => {
    expect(() => parseDiscordChannelUrl("https://discord.com/channels/abc/def")).toThrow(DiscordChannelUrlParseError);
  });

  it("rejects an empty string", () => {
    expect(() => parseDiscordChannelUrl("")).toThrow(DiscordChannelUrlParseError);
  });

  it("rejects http:// (non-https)", () => {
    expect(() => parseDiscordChannelUrl("http://discord.com/channels/1/2")).toThrow(DiscordChannelUrlParseError);
  });
});

describe("buildChannelUrl / buildMessageUrl", () => {
  it("derives a channel permalink from ids alone", () => {
    expect(buildChannelUrl("111", "222")).toBe("https://discord.com/channels/111/222");
  });

  it("derives a message permalink from ids alone", () => {
    expect(buildMessageUrl("111", "222", "333")).toBe("https://discord.com/channels/111/222/333");
  });
});
