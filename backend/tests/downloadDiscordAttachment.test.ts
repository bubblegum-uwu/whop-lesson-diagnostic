import { describe, it, expect, vi, afterEach } from "vitest";
import { downloadDiscordAttachment, DiscordAttachmentDownloadError } from "../src/discord/downloadDiscordAttachment.js";

const VALID_URL = "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=1&is=2&hm=3";

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeResponse(opts: { ok?: boolean; status?: number; body?: Uint8Array[]; contentType?: string; contentLength?: string } = {}) {
  const chunks = opts.body ?? [new Uint8Array([1, 2, 3, 4])];
  let i = 0;
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (name: string) => {
        if (name === "content-type") return opts.contentType ?? "video/mp4";
        if (name === "content-length") return opts.contentLength ?? null;
        return null;
      },
    },
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: chunks[i++] };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

describe("downloadDiscordAttachment", () => {
  it("downloads and returns the content/contentType/byteSize for a valid attachment URL", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ body: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadDiscordAttachment(VALID_URL);
    expect(result.content).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(result.contentType).toBe("video/mp4");
    expect(result.byteSize).toBe(5);
    expect(fetchMock).toHaveBeenCalledWith(VALID_URL, expect.anything());
  });

  it("rejects a URL that doesn't pass Discord CDN validation before ever calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadDiscordAttachment("https://evil.example/video.mp4")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a non-ok HTTP response (e.g. an expired signature) as a clear, actionable DiscordAttachmentDownloadError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: false, status: 403 })));
    await expect(downloadDiscordAttachment(VALID_URL)).rejects.toThrow(DiscordAttachmentDownloadError);
    await expect(downloadDiscordAttachment(VALID_URL)).rejects.toThrow(/invalid or expired/);
  });

  it("surfaces a network failure as a DiscordAttachmentDownloadError, never a raw/uncaught rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(downloadDiscordAttachment(VALID_URL)).rejects.toThrow(DiscordAttachmentDownloadError);
  });

  it("rejects a response advertising a content-length over the configured max, without reading the body", async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ contentLength: String(10 * 1024 * 1024) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadDiscordAttachment(VALID_URL, { maxBytes: 1024 })).rejects.toThrow(/too large/);
  });

  it("aborts and rejects if the actual streamed byte count exceeds the max (a lying/absent content-length header)", async () => {
    const bigChunk = new Uint8Array(2000);
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ body: [bigChunk], contentLength: null })));

    await expect(downloadDiscordAttachment(VALID_URL, { maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it("never logs or throws an error containing the signed query string itself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: false, status: 403 })));
    try {
      await downloadDiscordAttachment(VALID_URL);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err instanceof Error ? err.message : "").not.toContain("hm=3");
    }
  });
});
