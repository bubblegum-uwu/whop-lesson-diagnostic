import { describe, it, expect } from "vitest";
import { parseYouTubeVideoUrl, YouTubeUrlParseError } from "../src/lib/youtubeUrl.js";

describe("parseYouTubeVideoUrl", () => {
  it("A: parses a valid youtube.com/watch?v= URL", () => {
    const result = parseYouTubeVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("A: parses a bare youtube.com (no www) host", () => {
    const result = parseYouTubeVideoUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
  });

  it("A: parses an m.youtube.com host", () => {
    const result = parseYouTubeVideoUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
  });

  it("B: parses a valid youtu.be short URL", () => {
    const result = parseYouTubeVideoUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("C: always normalizes to the same canonical watch URL regardless of input form", () => {
    const fromWatch = parseYouTubeVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const fromShort = parseYouTubeVideoUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(fromWatch.sourceUrl).toBe(fromShort.sourceUrl);
    expect(fromWatch.externalId).toBe(fromShort.externalId);
  });

  it("D: ignores ordinary extra query parameters on a watch URL (playlist context, tracking, timestamp)", () => {
    const result = parseYouTubeVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=3&t=42s");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
    expect(result.sourceUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("D: ignores extra query parameters on a youtu.be URL", () => {
    const result = parseYouTubeVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=abc123tracking");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
  });

  it("E: rejects a malformed URL", () => {
    expect(() => parseYouTubeVideoUrl("not a url at all")).toThrow(YouTubeUrlParseError);
  });

  it("E: rejects an empty string", () => {
    expect(() => parseYouTubeVideoUrl("")).toThrow(YouTubeUrlParseError);
  });

  it("E: rejects a whitespace-only string", () => {
    expect(() => parseYouTubeVideoUrl("   ")).toThrow(YouTubeUrlParseError);
  });

  it("F: rejects a non-YouTube host", () => {
    expect(() => parseYouTubeVideoUrl("https://vimeo.com/12345")).toThrow(YouTubeUrlParseError);
  });

  it("F: rejects a hostname that merely contains 'youtube.com' as a suffix trick", () => {
    expect(() => parseYouTubeVideoUrl("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("F: rejects a hostname that merely starts with youtube.com (subdomain trick)", () => {
    expect(() => parseYouTubeVideoUrl("https://youtube.com.attacker.io/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("G: rejects a playlist-only URL", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/playlist?list=PLabc123")).toThrow(YouTubeUrlParseError);
  });

  it("G: rejects a channel URL (/channel/)", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/channel/UCabcdefghij")).toThrow(YouTubeUrlParseError);
  });

  it("G: rejects a handle-style channel URL (/@handle)", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/@somehandle")).toThrow(YouTubeUrlParseError);
  });

  it("H: rejects a file:// URL", () => {
    expect(() => parseYouTubeVideoUrl("file:///etc/passwd")).toThrow(YouTubeUrlParseError);
  });

  it("I: rejects a localhost host", () => {
    expect(() => parseYouTubeVideoUrl("https://localhost/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("I: rejects a private/internal IP literal host", () => {
    expect(() => parseYouTubeVideoUrl("https://169.254.169.254/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
    expect(() => parseYouTubeVideoUrl("https://127.0.0.1/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("rejects http:// (non-https) YouTube URLs", () => {
    expect(() => parseYouTubeVideoUrl("http://www.youtube.com/watch?v=dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("rejects a watch URL missing the v parameter", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/watch?list=PLabc123")).toThrow(YouTubeUrlParseError);
  });

  it("rejects a video id that isn't 11 characters", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/watch?v=short")).toThrow(YouTubeUrlParseError);
  });

  it("rejects a video id with invalid characters (shell-injection-shaped input)", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/watch?v=abc$(rm -rf)")).toThrow(YouTubeUrlParseError);
  });

  it("rejects a Shorts URL (not the supported watch/short-link forms)", () => {
    expect(() => parseYouTubeVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toThrow(YouTubeUrlParseError);
  });

  it("trims surrounding whitespace before parsing", () => {
    const result = parseYouTubeVideoUrl("  https://youtu.be/dQw4w9WgXcQ  ");
    expect(result.externalId).toBe("dQw4w9WgXcQ");
  });

  it("preserves case sensitivity of the video id", () => {
    const result = parseYouTubeVideoUrl("https://youtu.be/AbCdEfGhIjK");
    expect(result.externalId).toBe("AbCdEfGhIjK");
  });
});
