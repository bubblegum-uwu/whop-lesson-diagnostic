import { describe, it, expect } from "vitest";
import { buildSignedMuxHlsUrl, InvalidMuxAssetError } from "../src/mux/signedUrl.js";
import { createSecretRedactor } from "../src/lib/redact.js";

describe("buildSignedMuxHlsUrl", () => {
  it("builds the documented Mux signed HLS URL format", () => {
    const url = buildSignedMuxHlsUrl("pb_signed123", "tok_abc456");
    expect(url).toBe("https://stream.mux.com/pb_signed123.m3u8?token=tok_abc456");
  });

  it("URL-encodes special characters in the playback id and token", () => {
    const url = buildSignedMuxHlsUrl("pb/weird id", "tok with space");
    expect(url).toContain("stream.mux.com/pb%2Fweird%20id.m3u8");
    expect(url).toContain("token=tok%20with%20space");
  });

  it("throws InvalidMuxAssetError when signed_playback_id is missing", () => {
    expect(() => buildSignedMuxHlsUrl("", "tok_abc")).toThrow(InvalidMuxAssetError);
  });

  it("throws InvalidMuxAssetError when signed_video_playback_token is missing", () => {
    expect(() => buildSignedMuxHlsUrl("pb_abc", "")).toThrow(InvalidMuxAssetError);
  });

  it("the resulting URL is fully redactable once registered as a secret", () => {
    const redactor = createSecretRedactor();
    const url = buildSignedMuxHlsUrl("pb_signed789", "tok_secretvalue999");
    redactor.register(url);

    const out = redactor.redact(`About to fetch ${url}`);
    expect(out).not.toContain(url);
    expect(out).not.toContain("tok_secretvalue999");
    expect(out).not.toContain("pb_signed789");
  });
});
