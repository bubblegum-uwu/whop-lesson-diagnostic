import { describe, it, expect } from "vitest";
import { parseDiscordVideoUrl, DiscordUrlParseError } from "../src/lib/discordUrl.js";

const VALID_URL =
  "https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip.mp4?ex=65abc123&is=65aa1234&hm=deadbeef";

describe("parseDiscordVideoUrl", () => {
  it("K: reconstructs the stable externalId (attachment id) from a valid cdn.discordapp.com URL", () => {
    const parsed = parseDiscordVideoUrl(VALID_URL);
    expect(parsed.externalId).toBe("987654321098765432");
  });

  it("preserves the URL verbatim (including the signed query string) as sourceUrl — never normalized/reconstructed", () => {
    const parsed = parseDiscordVideoUrl(VALID_URL);
    expect(parsed.sourceUrl).toBe(VALID_URL);
  });

  it("accepts the media.discordapp.net proxy host identically", () => {
    const url = "https://media.discordapp.net/attachments/123456789012345678/987654321098765432/clip.mov?ex=1&is=2&hm=3";
    const parsed = parseDiscordVideoUrl(url);
    expect(parsed.externalId).toBe("987654321098765432");
  });

  it("L: rejects a hostname that merely contains 'discordapp.com' as a substring (SSRF hardening — exact match only)", () => {
    expect(() => parseDiscordVideoUrl("https://cdn.discordapp.com.evil.example/attachments/1/2/clip.mp4")).toThrow(DiscordUrlParseError);
  });

  it("rejects a non-Discord host entirely", () => {
    expect(() => parseDiscordVideoUrl("https://example.com/attachments/1/2/clip.mp4")).toThrow(DiscordUrlParseError);
  });

  it("rejects a non-https scheme", () => {
    expect(() => parseDiscordVideoUrl("http://cdn.discordapp.com/attachments/1/2/clip.mp4")).toThrow(DiscordUrlParseError);
  });

  it("rejects a malformed URL", () => {
    expect(() => parseDiscordVideoUrl("not a url")).toThrow(DiscordUrlParseError);
  });

  it("rejects an empty string", () => {
    expect(() => parseDiscordVideoUrl("")).toThrow(DiscordUrlParseError);
  });

  it("rejects a path that isn't the /attachments/<channel>/<id>/<filename> shape", () => {
    expect(() => parseDiscordVideoUrl("https://cdn.discordapp.com/emojis/123.png")).toThrow(DiscordUrlParseError);
  });

  it("rejects a non-numeric attachment id segment", () => {
    expect(() => parseDiscordVideoUrl("https://cdn.discordapp.com/attachments/123/not-a-number/clip.mp4")).toThrow(DiscordUrlParseError);
  });

  it("Q: rejects a non-video attachment (e.g. an image) — Phase 4I is video-only, same boundary as YouTube", () => {
    expect(() => parseDiscordVideoUrl("https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/screenshot.png")).toThrow(
      DiscordUrlParseError,
    );
  });

  it("rejects an attachment with no file extension at all", () => {
    expect(() => parseDiscordVideoUrl("https://cdn.discordapp.com/attachments/123456789012345678/987654321098765432/clip")).toThrow(
      DiscordUrlParseError,
    );
  });

  it("accepts every documented video extension case-insensitively", () => {
    for (const ext of ["mp4", "MOV", "webm", "MKV", "m4v"]) {
      expect(() => parseDiscordVideoUrl(`https://cdn.discordapp.com/attachments/1/2/clip.${ext}`)).not.toThrow();
    }
  });
});
