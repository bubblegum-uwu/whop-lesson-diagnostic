import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveYouTubeChannelId, YouTubeChannelResolveError } from "../src/youtube/resolveYoutubeChannel.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function htmlResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("resolveYouTubeChannelId", () => {
  it("returns a channel_id ref immediately, without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveYouTubeChannelId({ kind: "channel_id", channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw" });
    expect(id).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a handle to a channel ID via the canonical link tag", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://www.youtube.com/@SMBCapital");
      return htmlResponse(200, `<html><head><link rel="canonical" href="https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw"></head></html>`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveYouTubeChannelId({ kind: "handle", handle: "SMBCapital" });
    expect(id).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("throws a clear error when the channel page has no canonical channel link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(200, "<html><head></head></html>")));
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "DoesNotExist" })).rejects.toThrow(YouTubeChannelResolveError);
  });

  it("throws a clear error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(404, "")));
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "DoesNotExist" })).rejects.toThrow(YouTubeChannelResolveError);
  });

  it("throws a clear error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "SMBCapital" })).rejects.toThrow(YouTubeChannelResolveError);
  });
});
