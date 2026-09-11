import { describe, it, expect } from "vitest";
import { parseYouTubeChannelRef, YouTubeChannelUrlParseError } from "../src/lib/youtubeChannelUrl.js";

const REAL_CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

describe("parseYouTubeChannelRef", () => {
  it("parses a bare channel ID", () => {
    expect(parseYouTubeChannelRef(REAL_CHANNEL_ID)).toEqual({ kind: "channel_id", channelId: REAL_CHANNEL_ID });
  });

  it("parses a youtube.com/channel/UC... URL", () => {
    expect(parseYouTubeChannelRef(`https://www.youtube.com/channel/${REAL_CHANNEL_ID}`)).toEqual({
      kind: "channel_id",
      channelId: REAL_CHANNEL_ID,
    });
  });

  it("parses a bare @handle string (no URL wrapper)", () => {
    expect(parseYouTubeChannelRef("@SMBCapital")).toEqual({ kind: "handle", handle: "SMBCapital" });
  });

  it("parses a youtube.com/@handle URL", () => {
    expect(parseYouTubeChannelRef("https://www.youtube.com/@SMBCapital")).toEqual({ kind: "handle", handle: "SMBCapital" });
  });

  it("parses a youtube.com/c/CustomName URL", () => {
    expect(parseYouTubeChannelRef("https://www.youtube.com/c/SMBCapital")).toEqual({ kind: "handle", handle: "SMBCapital" });
  });

  it("parses a youtube.com/user/LegacyName URL", () => {
    expect(parseYouTubeChannelRef("https://www.youtube.com/user/SMBCapital")).toEqual({ kind: "handle", handle: "SMBCapital" });
  });

  it("rejects an empty string", () => {
    expect(() => parseYouTubeChannelRef("")).toThrow(YouTubeChannelUrlParseError);
  });

  it("rejects a malformed channel ID in a /channel/ URL", () => {
    expect(() => parseYouTubeChannelRef("https://www.youtube.com/channel/not-a-real-id")).toThrow(YouTubeChannelUrlParseError);
  });

  it("rejects a non-YouTube host", () => {
    expect(() => parseYouTubeChannelRef("https://evil.example.com/@SMBCapital")).toThrow(YouTubeChannelUrlParseError);
  });

  it("rejects a non-https scheme", () => {
    expect(() => parseYouTubeChannelRef("http://www.youtube.com/@SMBCapital")).toThrow(YouTubeChannelUrlParseError);
  });

  it("rejects a youtube.com/watch video URL — not a channel reference", () => {
    expect(() => parseYouTubeChannelRef("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeChannelUrlParseError);
  });

  it("rejects a youtube.com root URL with no channel segment", () => {
    expect(() => parseYouTubeChannelRef("https://www.youtube.com/")).toThrow(YouTubeChannelUrlParseError);
  });
});
