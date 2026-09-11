import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveYouTubeChannelId, YouTubeChannelResolveError } from "../src/youtube/resolveYoutubeChannel.js";
import { YouTubeApiNotConfiguredError } from "../src/youtube/youtubeDataApiClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("resolveYouTubeChannelId", () => {
  it("returns a channel_id ref immediately, without any network call or API key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveYouTubeChannelId({ kind: "channel_id", channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw" }, undefined);
    expect(id).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws YouTubeApiNotConfiguredError for a handle ref when no API key is configured, without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "SMBCapital" }, undefined)).rejects.toThrow(YouTubeApiNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a handle to a channel ID via channels.list?forHandle=", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/youtube/v3/channels");
      expect(parsed.searchParams.get("forHandle")).toBe("@SMBCapital");
      return jsonResponse(200, { items: [{ id: "UC_x5XG1OV2P6uZZ5FSM9Ttw" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const id = await resolveYouTubeChannelId({ kind: "handle", handle: "SMBCapital" }, "test-api-key");
    expect(id).toBe("UC_x5XG1OV2P6uZZ5FSM9Ttw");
  });

  it("throws a clear error when the API returns no matching channel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [] })));
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "DoesNotExist" }, "test-api-key")).rejects.toThrow(YouTubeChannelResolveError);
  });

  it("throws a clear error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(404, { error: { message: "not found" } })));
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "DoesNotExist" }, "test-api-key")).rejects.toThrow(YouTubeChannelResolveError);
  });

  it("throws a clear error on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(resolveYouTubeChannelId({ kind: "handle", handle: "SMBCapital" }, "test-api-key")).rejects.toThrow(YouTubeChannelResolveError);
  });
});
