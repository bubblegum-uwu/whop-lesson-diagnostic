import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getChannelUploadsPlaylistId,
  discoverYoutubeChannelVideosPage,
  YouTubeChannelDiscoveryError,
} from "../src/youtube/discoverYoutubeChannelVideos.js";
import { YouTubeApiNotConfiguredError } from "../src/youtube/youtubeDataApiClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CHANNEL_ID = "UC_x5XG1OV2P6uZZ5FSM9Ttw";

describe("getChannelUploadsPlaylistId", () => {
  it("throws YouTubeApiNotConfiguredError when no API key is given, without ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getChannelUploadsPlaylistId(CHANNEL_ID, undefined)).rejects.toThrow(YouTubeApiNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls channels.list with contentDetails+snippet and extracts the uploads playlist id + title", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/youtube/v3/channels");
      expect(parsed.searchParams.get("part")).toBe("contentDetails,snippet");
      expect(parsed.searchParams.get("id")).toBe(CHANNEL_ID);
      expect(parsed.searchParams.get("key")).toBe("test-api-key");
      return jsonResponse(200, {
        items: [{ snippet: { title: "SMB Capital" }, contentDetails: { relatedPlaylists: { uploads: "UU_x5XG1OV2P6uZZ5FSM9Ttw" } } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await getChannelUploadsPlaylistId(CHANNEL_ID, "test-api-key");
    expect(result).toEqual({ uploadsPlaylistId: "UU_x5XG1OV2P6uZZ5FSM9Ttw", channelTitle: "SMB Capital" });
  });

  it("throws a clear error when the channel doesn't exist (empty items)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [] })));
    await expect(getChannelUploadsPlaylistId(CHANNEL_ID, "test-api-key")).rejects.toThrow(YouTubeChannelDiscoveryError);
  });

  it("throws a clear error on an API error response, without ever including the API key in the message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: { message: "API key not valid." } })));
    await expect(getChannelUploadsPlaylistId(CHANNEL_ID, "test-api-key")).rejects.toThrow(/API key not valid/);
    try {
      await getChannelUploadsPlaylistId(CHANNEL_ID, "test-api-key");
    } catch (err) {
      expect((err as Error).message).not.toContain("test-api-key");
    }
  });
});

describe("discoverYoutubeChannelVideosPage", () => {
  it("throws YouTubeApiNotConfiguredError when no API key is given", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", undefined)).rejects.toThrow(YouTubeApiNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls playlistItems.list with the playlist id and page size, parses videos, and returns nextPageToken", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/youtube/v3/playlistItems");
      expect(parsed.searchParams.get("playlistId")).toBe("UU_x5XG1OV2P6uZZ5FSM9Ttw");
      expect(parsed.searchParams.get("maxResults")).toBe("50");
      expect(parsed.searchParams.has("pageToken")).toBe(false);
      return jsonResponse(200, {
        items: [
          { snippet: { title: "Opening Range Breakout", publishedAt: "2026-01-01T00:00:00Z", resourceId: { videoId: "aaaaaaaaaaa" } } },
          { snippet: { title: "Risk & Reward Basics", publishedAt: "2026-01-02T00:00:00Z", resourceId: { videoId: "bbbbbbbbbbb" } } },
        ],
        nextPageToken: "CAUQAA",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", "test-api-key");
    expect(result).toEqual({
      videos: [
        { videoId: "aaaaaaaaaaa", title: "Opening Range Breakout", publishedAt: "2026-01-01T00:00:00Z", sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
        { videoId: "bbbbbbbbbbb", title: "Risk & Reward Basics", publishedAt: "2026-01-02T00:00:00Z", sourceUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
      ],
      nextPageToken: "CAUQAA",
    });
  });

  it("passes pageToken through when continuing a previous page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(new URL(url).searchParams.get("pageToken")).toBe("CAUQAA");
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", "test-api-key", "CAUQAA");
  });

  it("returns nextPageToken: null on the last page (API omits the field)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [] })));
    const result = await discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", "test-api-key");
    expect(result.nextPageToken).toBeNull();
  });

  it("skips malformed entries (missing videoId/title) rather than crashing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          items: [{ snippet: { title: "Has no videoId" } }, { snippet: { resourceId: { videoId: "hasnotitle00" } } }, { snippet: { title: "Valid", resourceId: { videoId: "validvideoid" } } }],
        }),
      ),
    );
    const result = await discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", "test-api-key");
    expect(result.videos).toEqual([{ videoId: "validvideoid", title: "Valid", publishedAt: null, sourceUrl: "https://www.youtube.com/watch?v=validvideoid" }]);
  });

  it("throws a clear error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(discoverYoutubeChannelVideosPage("UU_x5XG1OV2P6uZZ5FSM9Ttw", "test-api-key")).rejects.toThrow(YouTubeChannelDiscoveryError);
  });
});
