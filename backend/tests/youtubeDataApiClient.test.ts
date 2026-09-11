import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchYouTubeDataApi, YouTubeApiRequestError } from "../src/youtube/youtubeDataApiClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchYouTubeDataApi", () => {
  it("builds the request URL from the base, path, params, and API key", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
      expect(parsed.searchParams.get("id")).toBe("UCabc");
      expect(parsed.searchParams.get("key")).toBe("secret-key");
      return jsonResponse(200, { items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchYouTubeDataApi("channels", { id: "UCabc" }, "secret-key");
  });

  it("returns the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { items: [{ id: "x" }] })));
    const result = await fetchYouTubeDataApi<{ items: unknown[] }>("channels", {}, "k");
    expect(result).toEqual({ items: [{ id: "x" }] });
  });

  it("throws YouTubeApiRequestError with the API's own message on a non-2xx response, never echoing the API key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: { message: "API key not valid. Please pass a valid API key." } })));
    let caught: unknown;
    try {
      await fetchYouTubeDataApi("channels", {}, "super-secret-key");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(YouTubeApiRequestError);
    expect((caught as Error).message).toContain("API key not valid");
    expect((caught as Error).message).not.toContain("super-secret-key");
  });

  it("throws YouTubeApiRequestError on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchYouTubeDataApi("channels", {}, "k")).rejects.toThrow(YouTubeApiRequestError);
  });

  it("throws YouTubeApiRequestError on an oversized response, without buffering it all into memory first", async () => {
    const hugeBody = "x".repeat(3 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(hugeBody, { status: 200 })));
    await expect(fetchYouTubeDataApi("channels", {}, "k")).rejects.toThrow(/unexpectedly large/);
  });
});
