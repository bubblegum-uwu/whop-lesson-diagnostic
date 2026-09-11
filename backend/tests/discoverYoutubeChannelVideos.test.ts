import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverYoutubeChannelVideos, YouTubeChannelDiscoveryError } from "../src/youtube/discoverYoutubeChannelVideos.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function xmlResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>SMB Capital</title>
  <entry>
    <yt:videoId>aaaaaaaaaaa</yt:videoId>
    <title>Opening Range Breakout</title>
    <published>2026-01-01T00:00:00+00:00</published>
  </entry>
  <entry>
    <yt:videoId>bbbbbbbbbbb</yt:videoId>
    <title>Risk &amp; Reward Basics</title>
    <published>2026-01-02T00:00:00+00:00</published>
  </entry>
</feed>`;

describe("discoverYoutubeChannelVideos", () => {
  it("fetches the official Atom feed URL for the given channel ID", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw");
      return xmlResponse(200, SAMPLE_FEED);
    });
    vi.stubGlobal("fetch", fetchMock);
    await discoverYoutubeChannelVideos("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses every entry into a DiscoveredYouTubeVideo, decoding XML entities in titles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(200, SAMPLE_FEED)));
    const { videos, channelTitle } = await discoverYoutubeChannelVideos("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(channelTitle).toBe("SMB Capital");
    expect(videos).toEqual([
      { videoId: "aaaaaaaaaaa", title: "Opening Range Breakout", publishedAt: "2026-01-01T00:00:00+00:00", sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
      { videoId: "bbbbbbbbbbb", title: "Risk & Reward Basics", publishedAt: "2026-01-02T00:00:00+00:00", sourceUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
    ]);
  });

  it("returns an empty video list for a channel with no uploads, without erroring", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(200, `<feed><title>Empty Channel</title></feed>`)));
    const { videos, channelTitle } = await discoverYoutubeChannelVideos("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(videos).toEqual([]);
    expect(channelTitle).toBe("Empty Channel");
  });

  it("throws a clear error for an unknown channel (404)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => xmlResponse(404, "")));
    await expect(discoverYoutubeChannelVideos("UCdoesnotexist00000000")).rejects.toThrow(YouTubeChannelDiscoveryError);
  });

  it("throws a clear error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(discoverYoutubeChannelVideos("UC_x5XG1OV2P6uZZ5FSM9Ttw")).rejects.toThrow(YouTubeChannelDiscoveryError);
  });
});
